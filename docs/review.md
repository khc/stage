# Architecture review

**Scope and verification:** Read `packages/agents`, `apps/service`, `agents/*` and parts of the README, plus 3 web searches. The stack was not run. `apps/extract` and `scripts/` were not read. No authentication was seen in the service code that was read, so it is not judged here.

## Overview

```
UI (apps/ui) → Hono service → Cloud Run Job (one image per agent set)
                  │                 └─ ADK Runner → Firestore sessions/events
                  └─ Firestore (tasks, docs, agent registry) + 2 Pub/Sub topics → SSE
```

Sessions, tasks and the agent registry all live in Firestore. A task run is a one-shot Cloud Run Job execution that gets `TASK_ID`, and `SESSION_ID` plus `MESSAGE` when resuming.

## What's sound

- **State lives outside the process.** Events are written to Firestore as each event arrives ([session-service.ts](../packages/agents/src/session-service.ts)). A resume is a fresh execution that loads the session from Firestore. This is the "persist outside the process, resume later" pattern that durable-execution guidance recommends for human waits ([Sista AI](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)).
- **Typed agent contracts.** Each agent is registered with input and output JSON Schemas ([spec.ts](../packages/agents/src/spec.ts)). Input is validated before the model runs, and the UI renders output from the schema.
- **Simple agents.** `assistant` and `document_analyser` are single LLM agents with tools or structured output. This matches Anthropic's advice to start with the simplest pattern and add orchestration only when it pays off ([Anthropic](https://www.anthropic.com/research/building-effective-agents)). That page notes that much of its tooling description has changed since December 2024.
- **Pub/Sub is best effort and Firestore is the source of truth.** Failed publishes never fail a run.

## Findings, by priority

**Status:** findings 1 and 2 are implemented and re-reviewed (see [Implementation status](#implementation-status)). Findings 3 to 8 are open.

1. **Done: no execution state.** The README says no status is written to the task. `POST /run` returns an operation name, and the UI drops it. The UI can't show running, succeeded or failed, or link a failure to a session. This is why the session list has no status.
   - **Fix:** write a small `runs/{sessionId}` document (`queued`, `running`, `succeeded`, `failed`, error, start and end times) from `main()` in [cli.ts](../packages/agents/src/cli.ts). The UI and stats then get it for free.

2. **Done (fencing open): no guard against concurrent runs of the same session.** Two resumes of one session, or repeated runs of a task, can append events at the same time. `seq` is computed from the in-memory event list ([session-service.ts:166](../packages/agents/src/session-service.ts#L166)), so two writers can produce duplicate or interleaved sequence numbers. Durable-agent guidance names this duplicate-resume risk: no lease, no fencing ([Diagrid](https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake)).
   - **Fix:** a Firestore transaction that takes an `activeRun` lease on the session before running, and a 409 from the service if one exists. Also make `/run` accept an idempotency key.

3. **`MESSAGE` is passed as a container env override.** It is limited in size and visible in Cloud Run execution metadata. The prompt can be up to 10k characters.
   - **Fix:** store the pending message in Firestore, for example `sessions/{id}.pendingMessage`, and pass only `SESSION_ID`.

4. **No failure or retry policy.** A crash mid-run exits 1 and leaves a half-written session with no recorded error and no resume path. There are no step limits, timeouts or token budgets on agents either; the stats exist but nothing enforces them. This is not tested; retry settings on the Cloud Run job definition were not inspected.
   - **Fix:** record the failure on the run document (finding 1), and add `maxLlmCalls` and a timeout in `createTaskAgent`.

5. **Agent registry is bespoke, and registering is heavy.**
   - Registration runs the whole container in `register` mode as a Cloud Run execution ([jobs.ts](../apps/service/src/jobs.ts)). Registering at image build or deploy time would be cheaper.
   - The registry shape (name, description, input and output schemas) is close to an A2A Agent Card. The A2A spec itself doesn't define a registry API ([Google Cloud Agent Registry](https://docs.cloud.google.com/agent-registry/a2a-protocol) is a vendor example). Borrow the card shape now so interop stays cheap later. The card format changed between 0.3 and 1.0, so check the current spec before relying on it.

6. **Session store scalability.** `listSessions` loads every session for the app and filters in memory ([session-service.ts](../packages/agents/src/session-service.ts)). `getSession` reads all events. `userId` is hardcoded to `"user"`. Fine at this scale; querying by `taskId` is the first fix.

7. **Two dashboards.** `apps/web` (still in the README, `Dockerfile.web` and the Taskfile) and `apps/ui` (newer commits) are both live. The README doesn't mention `apps/ui`.
   - **Fix:** pick one and delete the other.

8. **Only single agents, no orchestration.** `AgentSpec` takes any ADK `BaseAgent`, so sequential, parallel or loop agents drop in without changes. Don't add them until a real task needs one. First candidates: a reviewer or evaluator pass on `document_analyser` output, and a human-approval step, which finding 1 would make possible.

## Implementation status

Findings 1 and 2 are implemented. Review `a30e8eb3` found no blocking issues; tests (287) and the emulator session tests pass.

- **Run state:** each session document stores `runStatus`, `runStartedAt`, `runEndedAt`, `runError` and `runLeaseUntil`. `runState()` in [session-service.ts](../packages/agents/src/session-service.ts) turns them into `{status, startedAt, endedAt?, error?}`; a run whose lease lapsed is reported as failed ("The run stopped responding"). The session list and detail endpoints return it as `run`, and the UI shows a badge and polls every 5 seconds while a run is `running`.
- **Lease:** `startRun` takes a 10-minute lease in a Firestore transaction and throws `RunInProgressError` if a live lease exists. A timer renews it every third of the lease period, and every persisted event renews it too. `finishRun` records `succeeded` or `failed`, keeping only the first line of the error (200 characters at most).
- **Service:** `POST /tasks/:id/run` with a `sessionId` returns 409 `run_in_progress` while the session is running. The job-side transaction is the real guard; the service check only avoids starting a job that would fail.
- **Failure handling:** a failed success write is logged and does not fail the job.

**Still open from findings 1 and 2:**
- No `runId` fencing token. A paused or hung process whose lease lapsed can still append after a second run starts. Fixing it means making `appendEvent` a transaction that checks the `runId`.
- No "queued" state: a new run shows nothing until the job creates its session.
- No idempotency key on `/run`; repeated runs of a task still create separate sessions.
- The heartbeat unit test is timing-based and can flake on a loaded machine.

## Suggested order

Findings 1 and 2 are done. Next: 3, then 7. The rest can wait.

## Sources

- [Anthropic, Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Google Cloud Agent Registry, A2A](https://docs.cloud.google.com/agent-registry/a2a-protocol)
- [Resumable agent workflows](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)
- [Diagrid, Still Not Durable](https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake)
