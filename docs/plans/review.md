# Architecture review

Note: this review is of the Hono service that `apps/service` has since replaced (it was `apps/service` then, and is shown here as `apps/service-hono`, no longer in the tree; the links to it are dead). Re-review of the whole project at commit `28a0c5d`. The first version of this document reviewed `packages/agents`, `apps/service-hono` and `agents/*`; the second added `apps/extract-service`, `scripts/`, the Taskfile, Docker and compose files and the tooling. This one also covers the Terraform in `infra/` and, for the first time, security.

**Verification:** `bun test` (323 tests), typecheck, lint and `format:check` pass. The emulator-backed tests were not re-run for this version. `apps/ui` was reviewed through the work done on it, not file by file. The architecture diagram is [architecture.drawio](../architecture.drawio).

## Overview

```
UI (apps/ui) → Hono service → Cloud Run Job (one image per agent app)
                  │                 └─ ADK Runner → Firestore sessions/events
                  ├─ apps/extract-service (document → text)
                  └─ Firestore (tasks, docs, agent registry) + 2 Pub/Sub topics → SSE

infra/modules/stage: jobs, extract, topics · envs/local (Floci) · envs/gcp (APIs, Firestore, SAs, IAM, secret)
```

Sessions, tasks and the agent registry live in Firestore. A task run is a one-shot Cloud Run Job execution that gets `TASK_ID`, plus `SESSION_ID` when resuming. A resume message is queued on the session in Firestore, not passed in the environment. Terraform owns the jobs, the extract service and the topics; the service itself is not in Terraform (finding 4).

## What's sound

- **State lives outside the process.** Events are written to Firestore as each event arrives, and a resume is a fresh execution that loads the session ([session-service.ts](../../packages/agents/src/session-service.ts)). This is the "persist outside the process, resume later" pattern ([Sista AI](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)).
- **Typed agent contracts.** Each agent is registered with input and output JSON Schemas ([spec.ts](../../packages/agents/src/spec.ts)); the UI renders output from the schema, and each agent is also served as an Agent Card.
- **Run state and a lease.** Each session records its latest run (running, succeeded, failed) and a lease with a heartbeat, so two runs cannot start on one session.
- **A minimal job environment.** An execution gets only `TASK_ID` and, for a resume, `SESSION_ID`.
- **Simple agents.** `assistant`, `document_analyser`, `haiku-poet` and `limerick-poet` are single LLM agents, in line with Anthropic's advice to add orchestration only when it pays off ([Anthropic](https://www.anthropic.com/research/building-effective-agents)).
- **Pub/Sub is best effort and Firestore is the source of truth.** A failed publish never fails a run, and user messages are now published too.
- **Careful GCP Terraform for what it covers.** `extract` is internal-only with no `allUsers` invoker, the jobs and extract run as dedicated service accounts, the Gemini secret is created without a value so the key stays out of state, and GCP images must be pinned (no `latest`).
- **Hardened images.** All three Dockerfiles are multi-stage, the service and agent images use the distroless Bun base and run as a non-root UID (the extract image stays on slim because of a native module) and bake in no secrets; `.dockerignore` excludes `.env*`.
- **Consistent conventions.** `createX` factories, `toX` converters, snake_case error codes and kebab-case files are used throughout.

## Findings from the first review

| #   | Finding                                            | Status                                                    |
| --- | -------------------------------------------------- | --------------------------------------------------------- |
| 1   | No execution state                                 | Done.                                                     |
| 2   | No guard against concurrent runs of one session    | Done, including a `runId` fence.                          |
| 3   | `MESSAGE` passed as a container env override       | Done.                                                     |
| 4   | No failure or retry policy                         | Retries done (`max_retries = 0`); limits open: finding 5. |
| 5   | Agent registry is bespoke and registering is heavy | Done.                                                     |
| 6   | Session store scalability                          | Partly addressed; see finding 11.                         |
| 7   | Two dashboards                                     | Done: `apps/web` is removed.                              |
| 8   | Only single agents, no orchestration               | Unchanged by design.                                      |

### What was built

- **Run state (1):** each session document stores `runStatus`, `runStartedAt`, `runEndedAt`, `runError`, `runLeaseUntil` and `runMode` (`quick` on the agent service, `workflow` as the job; absent on runs from before it was kept). `runState()` turns them into `{status, startedAt, endedAt?, error?, mode?}`, and a run whose lease lapsed is reported as failed ("The run stopped responding"). The session endpoints return it as `run`, and the UI shows a badge and polls every 5 seconds while a run is `running`.
- **Lease (2):** `startRun` takes a 10-minute lease in a Firestore transaction and throws `RunInProgressError` when a live lease exists. A timer renews it every third of the lease period, and each persisted event renews it too. `finishRun` records `succeeded` or `failed` with only the first line of the error (200 characters at most). The service answers a resume of a running session with 409 `run_in_progress`.
- **Fencing (2):** `startRun` also stores a fresh `runId` on the session. While an instance holds a run, every event append, lease renewal and `finishRun` is a transaction that first checks the stored `runId` is still its own. A run whose lease lapsed and was taken over gets `RunLostError` on its next write, stops renewing, and its `finishRun` is a no-op, so it cannot overwrite the new run's events or status.
- **Queued message (3):** `queueMessage` stores the next message on the session in a transaction. It refuses while the session runs (`run_in_progress`) or while an earlier message queued after the last run started is under 60 seconds old (`message_pending`). The job reads the message with `pendingMessage`, and a successful `finishRun` clears it, so a retried task still finds it. If Cloud Run rejects the job, the service clears the message. A follow-up to a structured agent is free text: its input schema is checked only for a task's first message.
- **Retries (4):** the jobs ran with `maxRetries: 3`, the Cloud Run default, so a failed first run could leave up to four failed sessions and a retried resume could append the same user message twice. Terraform now sets `max_retries = 0` in [infra/modules/stage](../../infra/modules/stage/main.tf). The cost: a run lost to an infrastructure failure is not retried either, so the user starts it again.
- **Registry (5):** `task register-agents` writes straight to Firestore with no Cloud Run execution; `POST /jobs/:jobName/register` stays for the dashboard button. `GET /jobs/:jobName/agents/:agentName/card` serves an A2A-style Agent Card derived from the registry. It has no endpoint, because the service does not speak the A2A protocol.
- **Legacy sessions:** sessions created before the rename carry `appName` `agent-jobs`. `findOwner` looks up the real app and user at read time, so they can be resumed. The data itself is not migrated.

### Still open from findings 1 to 3

- No "queued" state: a new run shows nothing until the job creates its session.
- No idempotency key on `/run`; repeated runs of a task create separate sessions.
- The heartbeat unit test is timing-based (5 ms interval, 30 ms sleep) and can flake on a loaded machine.

## Open findings

Ordered by severity. "Likely" means the evidence is strong but was not exercised at runtime.

1. **Done: hyphenated agent names were rejected (bug, high).** The poet agents were renamed to `haiku-poet` and `limerick-poet`, which ADK 2.4.0 accepts, but the service's `agentNameSchema` allowed only letters, digits and underscores, so `POST /tasks` with `limerick-poet` and the agent-card route returned 400. There is now one `agentNameSchema` in [spec.ts](../../packages/agents/src/spec.ts) (`/^[A-Za-z_][A-Za-z0-9_-]*$/`, ADK's rule) and [schemas.ts](../../apps/service-hono/src/schemas.ts) imports it. Tests cover `limerick-poet` through `POST /tasks` and the schema itself, and the README describes the new rule. A change review of the fix found nothing blocking and no security impact. Left over, all low: no test sends a hyphenated name to the card route, and [README.md](../../README.md) lines 7, 67 and 146 still call the poet agent `haiku`. The fix is not committed yet.

2. **No authentication (security, high).** No route in [app.ts](../../apps/service-hono/src/app.ts) has authentication, authorization or rate limiting. Anyone who can reach the service can list, read and delete tasks, sessions and extracted document text, upload, run jobs and read the event streams. A local instance also accepts cross-site simple POSTs (register, run, upload). How exposed this is depends on a deployment that is not in the repository (finding 4).
   - **Fix:** put the service behind Cloud Run IAM (invoker only for the UI or backend identity) or IAP, verify ID tokens in `createApp`, and on routes that change state require a JSON content type or a custom header and check `Origin`.

3. **Any job in the project can be run (security, high).** `jobName` only has to match a DNS-label pattern. A task for a job with no registered agents is accepted ([task-service.ts](../../apps/service-hono/src/services/task-service.ts)), `run` executes it with env overrides, and `POST /jobs/:jobName/register` runs any named job with `args: ["register"]` ([cloud-run-jobs.ts](../../apps/service-hono/src/platform/cloud-run-jobs.ts)).
   - **Fix:** allow only configured jobs (from Terraform `agent_apps`, or the `-agents` suffix plus a registry entry), check it in `TaskService.create`, `run` and the register route, and grant `run.jobs.runWithOverrides` only on those jobs.

4. **The service is not in the GCP Terraform (design, medium).** [envs/gcp](../../infra/envs/gcp/main.tf) defines no Cloud Run service, service account, ingress or invoker for `apps/service-hono`, and none of the IAM it needs (Firestore, `runWithOverrides`, Pub/Sub subscribe and topic create, publish to `platform-events`). The service also calls `extract`, which accepts only `extract_invokers`, with a plain `fetch`, no ID token and no timeout ([document-store.ts](../../apps/service-hono/src/stores/document-store.ts)). The GCP environment therefore cannot run end to end, and the service's security is unmanaged.
   - **Fix:** add the service to Terraform with its own service account and minimal roles, add it to `extract_invokers`, and in `createExtractDocument` send an ID token (google-auth-library `getIdTokenClient`) with `AbortSignal.timeout`.

5. **No agent-level limits (design, medium; first-review finding 4).** There are no step limits, token budgets or timeouts inside `createTaskAgent` ([runtime.ts](../../packages/agents/src/runtime.ts)); only the job's own 600-second timeout applies. Stats exist but nothing enforces them.
   - **Fix:** pass an ADK `RunConfig` with `maxLlmCalls` to `runAsync` in `runSession`, and record hitting it as a failed run through `finishRun`.

6. **`GET /jobs` returns job env, including the local key (security, medium).** The route returns the raw Cloud Run Job definitions ([job-route.ts](../../apps/service-hono/src/routes/job-route.ts)), including container env. Locally `GEMINI_API_KEY` is a plain env value on the jobs ([envs/local](../../infra/envs/local/main.tf)), so any caller can read it. It is also in the local tfstate, which is world-readable on disk.
   - **Fix:** map the jobs to a smaller shape (name, image, conditions, update time, env names only) and never return `template`; `chmod 600` the local state files.

7. **Floci gets the host Docker socket (security, medium, likely; local only).** [docker-compose.yml](../../docker-compose.yml) mounts `/var/run/docker.sock` into the third-party Floci image, which exposes a job-launching API without credentials on `127.0.0.1:4588`.
   - **Fix:** pin the image by digest and put a Docker socket proxy in front of the socket; write down the trust assumption.

8. **Extract parses untrusted files without limits (security, medium, likely).** [xberg-client.ts](../../apps/extract-service/src/platform/xberg-client.ts) parses uploads inside the server process, trusts the client's MIME type, and sets no parser limits, deadline or concurrency cap. A parser hang or crash takes the service down.
   - **Fix:** set `securityLimits`, run the parser under a timeout or in a worker that can be killed, cap Cloud Run concurrency for extract, and allowlist or sniff MIME types.

9. **Document text is put in the system instruction (security, low).** The `document_analyser` concatenates the uploaded text and the client's filename into its instruction ([document-analyser.ts](../../agents/generic/src/document-analyser.ts)), which gives prompt injection from a document more weight. The agent has no tools, so the impact is limited to its output.
   - **Fix:** pass documents as separate, delimited user-message parts, escape filenames, and keep document-reading agents tool-less.

10. **Smaller security points (low).**
    - `apps/extract-service` returns the parser's error message to callers as is ([extractions-controller.ts](../../apps/extract-service/src/modules/extractions/extractions-controller.ts)). Fix: return a fixed code and log the detail.
    - The agent service account has `roles/datastore.user` on the whole project ([envs/gcp](../../infra/envs/gcp/main.tf)), so a future agent tool could read and write all Firestore data. Fix: a dedicated database with IAM conditions, or a written rule that agent tools never take arbitrary document paths.

11. **Session store scalability (low; first-review finding 6).** The service lists sessions by `taskId`, which is fine, but the ADK `listSessions` still loads every session of the app and pages in memory, `getSession` reads all events, and `userId` is hardcoded to `"user"`.
    - **Fix:** do the ordering, offset and limit in the Firestore query, and page the event read when sessions get long.

12. **Subscriptions are never cleaned up (low).** Each service process creates a Pub/Sub subscription named with a random UUID and a 24-hour expiry ([topic-subscriber.ts](../../apps/service-hono/src/platform/topic-subscriber.ts)) and never deletes it, so each restart, including each `bun --hot` reload, leaves one behind.
    - **Fix:** delete the subscription on shutdown, or use a stable per-environment name.

13. **`createSession` overwrites (low, likely).** It writes with `set`, so a caller-supplied `sessionId` would replace an existing session. The runtime never supplies one today.
    - **Fix:** use `create`, or a transaction that refuses an existing document.

14. **Unused job script (low).** [cloud-run-job.ts](../../scripts/cloud-run-job.ts) is no longer called now that Terraform owns the jobs; only its own test references it.
    - **Fix:** delete it and its test.

15. **Done: naming leftovers (low).** The document converter is `toDocumentSummary` and the session one `toSessionSummary`; the upload limits are `MAX_SERVICE_UPLOAD_BYTES` (25 MiB, service) and `MAX_EXTRACT_BYTES` (50 MiB, extract); the fallback error code is `internal_error`, with a test that the message is not returned; and `apps/extract-service` names the caught error `err`. The error code changed from `agent_error`; nothing in the repository (UI, tests, OpenAPI, README) used the old one.

16. **Stray text in a commit message (low).** Commits `bd7b359` and `c45dea1` end with `<|think_end|>`, a model-output token that was committed by mistake.
    - **Fix:** ignore it; it only affects history.

Also worth watching: agent names such as `constructor` pass validation, and `agents[agentName ?? defaultAgent]` in [runtime.ts](../../packages/agents/src/runtime.ts) would return an inherited member of the plain object; look names up with `Object.hasOwn`. Also, the queue of waiting events in [event-feed.ts](../../apps/service-hono/src/services/event-feed.ts) has no size limit, so a stalled `/events` client makes memory grow.

## Service structure

`apps/service-hono/src/app.ts` used to hold about 30 routes in one 462-line file. Following Hono's guidance of one `Hono` app per feature mounted with `app.route()` ([best practices](https://hono.dev/docs/guides/best-practices#building-a-larger-application)), the routes now live in `apps/service-hono/src/routes/` (`meta`, `event`, `job`, `task`, `document` and `session`), plus a `shared.ts` with `sseResponse`. `app.ts` is now about 55 lines.

Done, then still to do in order:

1. Done: `createApp` takes one `Deps` object (`jobs`, `tasks`, `sessions`, `registry`, and the optional `documents`, `sessionEventStream` and `platformEventStream`) instead of 11 positional arguments. `index.ts` builds it, and the tests build theirs with a `buildApp(overrides)` helper in `app.test.ts`.
2. Done: the resume flow and the cascade delete moved into `services/task-service.ts`, a `TaskService` with `create`, `run` and `delete` (the agent-name check of `POST /tasks` moved there too). They return a status for every expected outcome (`task_not_found`, `run_in_progress`, `message_pending` and so on) and throw a `DependencyError` carrying a short code when Firestore, Cloud Run or Pub/Sub fail. `routes/task-route.ts` only parses the request and maps the status to an HTTP code. Each use case has its own unit tests.
3. Done: every route reports a failing dependency by throwing a `DependencyError` (through `guard(code, call)`), and `app.onError` turns it into a 502 with that code and logs the cause. The per-route `try` blocks and the `badGateway` helper are gone. Expected outcomes, such as a too-large document, are still answered where they happen.
4. Done: the Firestore access moved to `stores/` (`tasks`, `sessions`, `documents`) and the Cloud Run, Pub/Sub and event-stream code to `platform/` (`cloud-run-jobs-client`, `cloud-run-jobs`, `topic-subscriber`, `session-event-stream`, `platform-event-stream`, `platform-event-publisher`), each with its tests. Files only moved; their contents did not change. The three stores now share one shape: `TaskStore`, `SessionStore` and `DocumentStore`, made by `createXStore(db)`, with the verbs `create`, `list`, `get` and `delete` (`delete` returns a boolean) plus domain verbs. This replaced `add` and `remove` on documents and the four separate task functions. The same was done for the Cloud Run client (`CloudRunJobs` with `list`, `run` and `registerAgents`, from three function types and three factories) and the agent registry (`AgentRegistry` with `list` and `register`, from two), and `POST /jobs/:job/register` no longer has a 501 case, and `DELETE /tasks/:id` no longer has a 501 case, since deleting is always available.
5. Done: the two Server-Sent Events loops moved out of the routes. `services/event-feed.ts` (now an `EventFeed` class) turns pushed events into an async sequence (each id once, older events can be put in front, "idle" when nothing arrives, ends on an abort signal). `SessionService.messages` subscribes before reading the stored history and returns the feed, and `PlatformEventService.stream` does the same for the service's own events. `routes/shared.ts` has one `sseResponse` that frames the feed as SSE and sends the keepalive comment. `session-route.ts` went from 112 to 70 lines and `event-route.ts` from 50 to 13. While testing the feed I found and fixed a hang: if the client disconnected while the consumer was busy writing an entry, the feed waited for a wake-up that never came.
6. Partly done: `openapi.test.ts` fails when a registered route has no OpenAPI entry or the reverse, which stops path drift (it checks paths and methods only, not the response codes inside an entry). Generating the document from the routes was tried on the jobs routes with `@hono/zod-openapi` 1.6.3, which works with Zod 4.6.7: validation errors keep the same 400 body, and the generated document carries each parameter's pattern and length. It was not adopted, because the four routes grew from 32 to 101 lines (about the same as their hand-written entries in `openapi.ts`, so nothing shrinks), every route must list its response codes and each handler must return exactly those, and the shared `schemas.ts` would have to move to the package's `z`. The real gain is that a handler that returns a status or shape its route does not declare fails to compile. Adopt it if that matters more than the extra verbosity.

## Suggested order

1. Authentication and a job allowlist (2, 3), together with putting the service in Terraform (4), before the service is reachable by anyone untrusted. Trim `GET /jobs` (6) in the same pass.
2. Agent-level limits (5), so a runaway agent cannot spend unbounded model calls.
3. Extract hardening (8) before accepting uploads from untrusted users.
4. The "queued" state, only if the gap before a job starts becomes a problem for users.
5. Everything else (7, 9 to 14, 16, and the README agent names) when touching those files.

## Sources

- [Anthropic, Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Google Cloud Agent Registry, A2A](https://docs.cloud.google.com/agent-registry/a2a-protocol)
- [Resumable agent workflows](https://blog.sista.ai/2026/03/resumable-agent-workflows-how-to-build.html)
- [Diagrid, Still Not Durable](https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake)
