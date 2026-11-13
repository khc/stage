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

3. **Done: job script defaults were stale.** [cloud-run-job.ts](../scripts/cloud-run-job.ts) no longer defaults to `my-agent-job` and a guessed image. `jobTarget` takes `JOB_APP` (`generic`, `poet`) and derives `<app>-agents` and `stage-<app>:latest` from it; `JOB_NAME` and `JOB_IMAGE` override either, and the script fails with a clear message when nothing is set. The Taskfile passes only `JOB_APP`.

4. **Done: README and compose disagreed.** The README now says compose starts Floci, Floci UI and the extract service, and that the API and the dashboard run on the host (`bun run dev:service`, `bun run dev:ui`). It explains the commented `service` block as the container alternative, drops the stale `JOB=my-job` and `my-agent-job` examples, and gives the restart step for the host service. `apps/ui` still has no Docker image or compose entry.

5. **Session store scalability (finding 6, low).** The service lists sessions by `taskId`, which is fine, but the ADK `listSessions` still loads every session of the app and filters in memory, `getSession` reads all events, and `userId` is hardcoded to `"user"`. `findOwner` adds a lookup by `sessionId`.
   - **Fix:** query by `taskId` or `userId` in `listSessions`, and page the event read when sessions get long.

6. **Subscriptions are never cleaned up (low, likely).** Each service process creates a Pub/Sub subscription named with a random UUID and a 24-hour expiry ([session-event-stream.ts](../apps/service/src/platform/session-event-stream.ts), [platform-event-stream.ts](../apps/service/src/platform/platform-event-stream.ts)) and never deletes it, so each restart, including each `bun --hot` reload, can leave one behind.
   - **Fix:** delete the subscription on shutdown, or use a stable per-environment name.

7. **`createSession` overwrites (low, likely).** It writes with `set`, so a caller-supplied `sessionId` would replace an existing session. The runtime never supplies one today.
   - **Fix:** use `create`, or a transaction that refuses an existing document.

8. **Naming inconsistencies (low).**
   - `EventListener` in `session-event-stream.ts` shadowed the DOM global type of the same name: done, it is now `StreamListener`.
   - `TaskDocument` was declared twice with different shapes: done, the service type is now `StoredDocument`.
   - `createCreateTask` repeated the verb: done, the task functions are one `TaskStore` made by `createTaskStore`.
   - Converters are named `summary`, `toSummary`, `toContract` and `toExtraction`.
   - The upload limits are `MAX_UPLOAD_BYTES` (25 MiB, service) and `MAX_FILE_BYTES` (50 MiB, extract).
   - The fallback error code is `agent_error` although it covers any unhandled error.
   - `apps/extract` names caught errors `e`; the rest uses `err`.
   - **Fix:** rename to `StreamListener`, `StoredDocument`, a `toX` name per converter, limits that say who enforces them, `internal_error` and `err`.

9. **Stray text in a commit message (low).** Commit `bd7b359` ends with `<|think_end|>`, a model-output token that was committed by mistake.
   - **Fix:** amend or ignore it; it only affects history.

## Service structure

`apps/service/src/app.ts` used to hold about 30 routes in one 462-line file. Following Hono's guidance of one `Hono` app per feature mounted with `app.route()` ([best practices](https://hono.dev/docs/guides/best-practices#building-a-larger-application)), the routes now live in `apps/service/src/routes/`: `meta`, `events`, `jobs`, `tasks`, `documents` and `sessions`, plus a `shared.ts` with the `badGateway` helper that replaced the repeated `HTTPException(502, …)` blocks. `app.ts` is now about 40 lines.

Done, then still to do in order:

1. Done: `createApp` takes one `Deps` object (`runJob`, `listJobs`, `createTask`, `listTasks`, `getTask`, `sessions`, and the optional `deleteTask`, `documents`, `registry`, `sessionEvents` and `platformStream`) instead of 11 positional arguments. `index.ts` builds it, and the tests build theirs with a `buildApp(overrides)` helper in `app.test.ts`.
2. Done: the resume flow and the cascade delete moved into `services/task-service.ts`, a `TaskService` with `create`, `run` and `delete` (the agent-name check of `POST /tasks` moved there too). They return a status for every expected outcome (`task_not_found`, `run_in_progress`, `message_pending` and so on) and throw a `DependencyError` carrying a short code when Firestore, Cloud Run or Pub/Sub fail. `routes/task-route.ts` only parses the request and maps the status to an HTTP code. Each use case has its own unit tests.
3. Done: every route reports a failing dependency by throwing a `DependencyError` (through `guard(code, call)`), and `app.onError` turns it into a 502 with that code and logs the cause. The per-route `try` blocks and the `badGateway` helper are gone. Expected outcomes, such as a too-large document, are still answered where they happen.
4. Done: the Firestore access moved to `stores/` (`tasks`, `sessions`, `documents`) and the Cloud Run, Pub/Sub and event-stream code to `platform/` (`cloud-run-jobs-client`, `cloud-run-jobs`, `topic-subscriber`, `session-event-stream`, `platform-event-stream`, `platform-event-publisher`), each with its tests. Files only moved; their contents did not change. The three stores now share one shape: `TaskStore`, `SessionStore` and `DocumentStore`, made by `createXStore(db)`, with the verbs `create`, `list`, `get` and `delete` (`delete` returns a boolean) plus domain verbs. This replaced `add` and `remove` on documents and the four separate task functions. The same was done for the Cloud Run client (`CloudRunJobs` with `list`, `run` and `registerAgents`, from three function types and three factories) and the agent registry (`AgentRegistry` with `list` and `register`, from two), and `POST /jobs/:job/register` no longer has a 501 case, and `DELETE /tasks/:id` no longer has a 501 case, since deleting is always available.
5. Partly done: `openapi.test.ts` fails when a registered route has no OpenAPI entry or the reverse, which stops path drift (it checks paths and methods only, not the response codes inside an entry). Generating the document from the routes was tried on the jobs routes with `@hono/zod-openapi` 1.6.3, which works with Zod 4.6.7: validation errors keep the same 400 body, and the generated document carries each parameter's pattern and length. It was not adopted, because the four routes grew from 32 to 101 lines (about the same as their hand-written entries in `openapi.ts`, so nothing shrinks), every route must list its response codes and each handler must return exactly those, and the shared `schemas.ts` would have to move to the package's `z`. The real gain is that a handler that returns a status or shape its route does not declare fails to compile. Adopt it if that matters more than the extra verbosity.

## Suggested order

Open findings 1, 3 and 4 are done. What remains, in the order I would take it:

1. Agent-level limits (2), so a runaway agent cannot spend unbounded model calls.
2. The "queued" state, only if the gap before a job starts becomes a problem for users.
3. Everything else (5 to 9) when touching those files.

## Sources

- [Anthropic, Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Google Cloud Agent Registry, A2A](https://docs.cloud.google.com/agent-registry/a2a-protocol)
- [Resumable agent workflows](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)
- [Diagrid, Still Not Durable](https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake)
