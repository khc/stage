# Architecture review

Re-review of the whole project at commit `66c2bf6`. The first version of this document reviewed `packages/agents`, `apps/service` and `agents/*`; this one also covers `apps/extract`, `scripts/`, the Taskfile, Docker and compose files and the tooling.

**Verification:** `bun run typecheck`, `bun run lint`, `bun run format:check` and `bun test` (278 tests) pass. The emulator-backed tests for `packages/agents` and the service sessions (92 tests) pass against Floci. `apps/ui` was reviewed through the work done on it, not file by file, and no authentication was seen in the service code, so it is not judged here. The architecture diagram is [architecture.drawio](architecture.drawio).

## Overview

```
UI (apps/ui) → Hono service → Cloud Run Job (one image per agent app)
                  │                 └─ ADK Runner → Firestore sessions/events
                  ├─ apps/extract (document → text)
                  └─ Firestore (tasks, docs, agent registry) + 2 Pub/Sub topics → SSE
```

Sessions, tasks and the agent registry live in Firestore. A task run is a one-shot Cloud Run Job execution that gets `TASK_ID`, plus `SESSION_ID` when resuming. A resume message is queued on the session in Firestore, not passed in the environment.

## What's sound

- **State lives outside the process.** Events are written to Firestore as each event arrives, and a resume is a fresh execution that loads the session ([session-service.ts](../packages/agents/src/session-service.ts)). This is the "persist outside the process, resume later" pattern ([Sista AI](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)).
- **Typed agent contracts.** Each agent is registered with input and output JSON Schemas ([spec.ts](../packages/agents/src/spec.ts)); the UI renders output from the schema, and each agent is also served as an Agent Card.
- **Run state and a lease.** Each session records its latest run (running, succeeded, failed) and a lease with a heartbeat, so two runs cannot start on one session.
- **A minimal job environment.** An execution gets only `TASK_ID` and, for a resume, `SESSION_ID`.
- **Simple agents.** `assistant`, `document_analyser` and `haiku` are single LLM agents, in line with Anthropic's advice to add orchestration only when it pays off ([Anthropic](https://www.anthropic.com/research/building-effective-agents)).
- **Pub/Sub is best effort and Firestore is the source of truth.** A failed publish never fails a run, and user messages are now published too.
- **Consistent conventions.** `createX` factories, `toX` converters, snake_case error codes and kebab-case files are used throughout, apart from the exceptions listed below.

## Findings from the first review

| #   | Finding                                            | Status                                 |
| --- | -------------------------------------------------- | -------------------------------------- |
| 1   | No execution state                                 | Done.                                  |
| 2   | No guard against concurrent runs of one session    | Done, including a `runId` fence.       |
| 3   | `MESSAGE` passed as a container env override       | Done.                                  |
| 4   | No failure or retry policy                         | Partly done; see finding 4 below.      |
| 5   | Agent registry is bespoke and registering is heavy | Done.                                  |
| 6   | Session store scalability                          | Partly addressed; see finding 6 below. |
| 7   | Two dashboards                                     | Done: `apps/web` is removed.           |
| 8   | Only single agents, no orchestration               | Unchanged by design.                   |

### What was built

- **Run state (1):** each session document stores `runStatus`, `runStartedAt`, `runEndedAt`, `runError` and `runLeaseUntil`. `runState()` turns them into `{status, startedAt, endedAt?, error?}`, and a run whose lease lapsed is reported as failed ("The run stopped responding"). The session endpoints return it as `run`, and the UI shows a badge and polls every 5 seconds while a run is `running`.
- **Lease (2):** `startRun` takes a 10-minute lease in a Firestore transaction and throws `RunInProgressError` when a live lease exists. A timer renews it every third of the lease period, and each persisted event renews it too. `finishRun` records `succeeded` or `failed` with only the first line of the error (200 characters at most). The service answers a resume of a running session with 409 `run_in_progress`.
- **Fencing (2):** `startRun` also stores a fresh `runId` on the session. While an instance holds a run, every event append, lease renewal and `finishRun` is a transaction that first checks the stored `runId` is still its own. A run whose lease lapsed and was taken over gets `RunLostError` on its next write, stops renewing, and its `finishRun` is a no-op, so it cannot overwrite the new run's events or status.
- **Queued message (3):** `queueMessage` stores the next message on the session in a transaction. It refuses while the session runs (`run_in_progress`) or while an earlier message queued after the last run started is under 60 seconds old (`message_pending`). The job reads the message with `pendingMessage`, and a successful `finishRun` clears it, so a retried task still finds it. If Cloud Run rejects the job, the service clears the message. A follow-up to a structured agent is free text: its input schema is checked only for a task's first message.
- **Registry (5):** `task register-agents` writes straight to Firestore with no Cloud Run execution; `POST /jobs/:jobName/register` stays for the dashboard button. `GET /jobs/:jobName/agents/:agentName/card` serves an A2A-style Agent Card derived from the registry. It has no endpoint, because the service does not speak the A2A protocol.
- **Legacy sessions:** sessions created before the rename carry `appName` `agent-jobs`. `findOwner` looks up the real app and user at read time, so they can be resumed. The data itself is not migrated.

### Still open from findings 1 to 3

- No "queued" state: a new run shows nothing until the job creates its session.
- No idempotency key on `/run`; repeated runs of a task create separate sessions.
- The heartbeat unit test is timing-based (5 ms interval, 30 ms sleep) and can flake on a loaded machine.

## Open findings

1. **Done: retries multiplied failed runs (finding 4).** The jobs had `maxRetries: 3`, the Cloud Run default, so a failed first run could leave up to four failed sessions and a retried resume could append the same user message twice. `create-job` and `update-job` now set `maxRetries: 0` ([cloud-run-job.ts](../scripts/cloud-run-job.ts)). I updated both Floci jobs and confirmed a deliberately failing run makes one execution and no retry. The cost: a run lost to an infrastructure failure is not retried either, so the user starts it again. I did not test whether Floci retried before the change.

2. **No agent-level limits (finding 4, low).** There are no step limits, token budgets or timeouts inside `createTaskAgent`; only the job's own 600-second timeout applies. Stats exist but nothing enforces them.
   - **Fix:** add a maximum number of model calls in `createTaskAgent` and record hitting it as a failed run.

3. **Job script defaults are stale (medium).** [cloud-run-job.ts](../scripts/cloud-run-job.ts) defaults the job to `my-agent-job` and the image to `stage-${job}:latest`. Jobs are named `generic-agents` and `poet-agents` while the images are `stage-generic` and `stage-poet`, so only the Taskfile's explicit `JOB_IMAGE` makes it work.
   - **Fix:** require `JOB_IMAGE`, or take an app name and derive both the image and the `<app>-agents` job name.

4. **README and compose disagree (medium).** README says `docker compose up -d --build` builds and starts the service, and tells readers to run `docker compose up -d --build service`, but the `service` block in [docker-compose.yml](../docker-compose.yml) is commented out. `apps/ui` also has no Docker image or compose entry.
   - **Fix:** enable the service block, or change the README to say the service runs with `bun run dev:service`; decide how the UI is served in production.

5. **Session store scalability (finding 6, low).** The service lists sessions by `taskId`, which is fine, but the ADK `listSessions` still loads every session of the app and filters in memory, `getSession` reads all events, and `userId` is hardcoded to `"user"`. `findOwner` adds a lookup by `sessionId`.
   - **Fix:** query by `taskId` or `userId` in `listSessions`, and page the event read when sessions get long.

6. **Subscriptions are never cleaned up (low, likely).** Each service process creates a Pub/Sub subscription named with a random UUID and a 24-hour expiry ([live-events.ts](../apps/service/src/live-events.ts), [platform-stream.ts](../apps/service/src/platform-stream.ts)) and never deletes it, so each restart, including each `bun --hot` reload, can leave one behind.
   - **Fix:** delete the subscription on shutdown, or use a stable per-environment name.

7. **`createSession` overwrites (low, likely).** It writes with `set`, so a caller-supplied `sessionId` would replace an existing session. The runtime never supplies one today.
   - **Fix:** use `create`, or a transaction that refuses an existing document.

8. **Naming inconsistencies (low).**
   - `EventListener` in `live-events.ts` shadows the DOM global type of the same name.
   - `TaskDocument` is declared twice with different shapes, in `apps/service/src/documents.ts` and `packages/agents/src/task-documents.ts`.
   - `createCreateTask` repeats the verb.
   - Converters are named `summary`, `toSummary`, `toContract` and `toExtraction`.
   - The upload limits are `MAX_UPLOAD_BYTES` (25 MiB, service) and `MAX_FILE_BYTES` (50 MiB, extract).
   - The fallback error code is `agent_error` although it covers any unhandled error.
   - `apps/extract` names caught errors `e`; the rest uses `err`.
   - **Fix:** rename to `StreamListener`, `StoredDocument`, a `toX` name per converter, limits that say who enforces them, `internal_error` and `err`.

9. **Stray text in a commit message (low).** Commit `bd7b359` ends with `<|think_end|>`, a model-output token that was committed by mistake.
   - **Fix:** amend or ignore it; it only affects history.

## Suggested order

1. The job script defaults (3) and the README and compose mismatch (4), because they make the setup unreliable for a new reader.
2. The "queued" state, only if the gap before a job starts becomes a problem for users.
3. Everything else (5 to 9) when touching those files.

## Sources

- [Anthropic, Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Google Cloud Agent Registry, A2A](https://docs.cloud.google.com/agent-registry/a2a-protocol)
- [Resumable agent workflows](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)
- [Diagrid, Still Not Durable](https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake)
