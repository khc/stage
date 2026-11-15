# service plan

The Elysia HTTP service, a rebuild of the Hono service it replaced, laid out by feature and driven by the platform's shape, not by the Hono code.

Status: the rebuild is done and the Hono service has been removed (two parity passes found no response that differs in status; see the results below). Its last version is in git history, in `apps/service` of the commit before the rename, if a comparison is ever needed. This app was `apps/service2` while both existed; `infra/` was renamed with it (the Cloud Run service `service`, `deploy_service`, the image `stage-service`). It listens on `127.0.0.1:3000`. What is still open is the GCP deployment (see "Still to do")

## Goal

- Same API as the Hono service: same routes, status codes and error codes (`task_not_found`, `run_in_progress`, ...), so `apps/ui` and the agent jobs work unchanged.
- Less code to maintain: schemas written once, in each module's model; OpenAPI generated from the routes; UI types from the routes (Eden) instead of hand-written ones.
- Decide with evidence whether Elysia replaces Hono. Phase 0 and the parity phase produce that evidence; this plan does not assume the answer.

## Platform facts that shape the design

- The service is a thin control plane: it creates tasks, starts Cloud Run Job executions, reads Firestore and relays Pub/Sub as SSE. The agent jobs do the work.
- Firestore documents (tasks, sessions, agent registry, run leases) are a contract shared with the jobs, which write them through `packages/agents`.
- A run is asynchronous: `/run` returns once the execution is started; progress arrives by polling or SSE. Firestore is the source of truth, Pub/Sub is best effort.
- Every GCP system is reached through a client configured only by environment variables (Floci locally, real GCP in production).
- The service is not in Terraform today; the jobs, extract and topics are.

## Layout

```
apps/service/src/
  index.ts  app.ts  config.ts
  http/        errors.ts  request-id.ts  telemetry.ts       # cross-cutting plugins
  platform/    firestore-client.ts  cloud-run-jobs-client.ts  pubsub-client.ts  extract-client.ts
  modules/
    tasks/     tasks-controller.ts  tasks-service.ts  tasks-model.ts  tasks-store.ts
      sessions/    sessions-controller.ts  sessions-service.ts  sessions-model.ts  sessions-store.ts
      documents/   documents-controller.ts  documents-service.ts  documents-model.ts  documents-store.ts
    agents/  events/  health/        # <module>-controller.ts  <module>-service.ts  <module>-model.ts each
```

Rules:

- One Elysia instance per controller (`<module>-controller.ts`; Elysia's guide calls it `index.ts`, we keep the role suffix the rest of the repo uses), mounted with `.use()`. Handlers destructure what they need and call the service; the service never receives Elysia's `Context`.
- Services, stores and platform clients are factories, not classes, so a method passed around (`.get("/", service.list)`, destructuring, callbacks) keeps working without `this` binding, and tests pass plain fake objects. Controllers are always Elysia instances, never classes.
- Each one is a trio per file: `<Thing>` (the type of the returned object), `<Thing>Deps` (its injected collaborators) and `create<Thing>(deps)`. Named exports only. Export `<Thing>Deps` only when something outside the file needs it. A factory with a single dependency skips the type: `createTasksStore(firestore)`.
- A dependency is named after its type in camelCase: `tasksStore: TasksStore`, `sessionsStore: SessionsStore`, `documentsStore: DocumentsStore`, `cloudRunJobs: CloudRunJobs`. Optional ones keep the name (`documentsStore?: DocumentsStore`). Plain config values (`topic`, `region`) are not dependencies and are named for what they hold. A factory that takes both uses `(deps, config)`.
- Files and symbols are named after the module, in the plural, like the folder: `tasks-service.ts`, `TasksService`, `createTasksService(deps)`, `tasks-store.ts`, `TasksStore`. Types that describe a single entity keep the singular (`NewTask`, `TaskContract`, `CreateTaskResult`). Health is `health-*` because the word has no plural.
- Services are `create<Thing>Service(deps)` factories returning an object with one method per operation. Each returns a status for every expected outcome and throws `DependencyError` when a dependency fails.
- Stores are `create<Thing>Store(firestore)` (`createTasksStore`) and live in the module that owns the collection. Tasks is the aggregate root: sessions and documents are keyed by `taskId`, nested under it, and reached by the tasks service inside its own folder.
- URLs come from each instance's `prefix`, not from folders (`/tasks`, then `/:taskId/sessions`, `/:taskId/documents`).
- `platform/` clients are named after the system they wrap, take `(client, config)`, and are passed in explicitly. `index.ts` builds them once and calls `createApp(deps)`. No DI container for now.
- Routes are one unbroken chain, and `createApp` exports its type, or Eden loses its types.
- Register `onError` (from `http/errors.ts`) before the routes it covers.
- Naming and file rules are in [AGENTS.md](../../AGENTS.md), including the exception for this app.

## Open decisions (settle in Phase 0)

| #   | Question                                                                                                                                                                                                                                                                                        | How to settle it                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Settled, see Spike results.** Can the tasks controller resolve `:taskId` once for the nested sessions and documents plugins, so children need no task store or 404 check? The Elysia pages read say plugins do not inherit lifecycle hooks by default and `guard` does not support `resolve`. | Spike: a named `task.guard` plugin with `.resolve({ as: "scoped" }, ...)` that each child `.use()`s; test the 404 with `app.handle(new Request(...))`. Fallback: inject an `exists(taskId)` call from the tasks service.                                                               |
| D2  | **Settled: no `packages/contracts`.** How do shared schemas and each `<module>-model.ts` split the work?                                                                                                                                                                                        | Each module's `<module>-model.ts` (TypeBox) is the one place for its schemas; OpenAPI is generated from the routes, and the UI gets its types from them through Eden. The jobs' side of the contract (task and session documents) stays in `@stage/agents`, which the service imports. |
| D3  | **Settled: reuse.** Does `tasks/sessions` keep its own store or reuse the session logic in `packages/agents` that the jobs use (leases, `runId` fencing)?                                                                                                                                       | Compare `session-store` in the Hono service with `packages/agents/src/session-service.ts`; prefer importing the shared code over duplicating lease logic.                                                                                                                              |
| D4  | **Settled, yes.** Does a dynamic prefix (`/:taskId/sessions`) work in nested plugins?                                                                                                                                                                                                           | Part of the D1 spike.                                                                                                                                                                                                                                                                  |
| D5  | DI container?                                                                                                                                                                                                                                                                                   | No. Revisit only if the wiring in `index.ts` outgrows one screen or request-scoped instances are needed (try `derive`/`resolve` first).                                                                                                                                                |

## Spike results

**D1 and D4 settled (Elysia 1.4.32, throwaway tests, since deleted).** Nested plugins with a dynamic prefix and a shared `:taskId` guard work:

- A prefix with a parameter works in a nested plugin: `new Elysia({ prefix: "/:taskId/sessions" })` mounted under `new Elysia({ prefix: "/tasks" })` serves `/tasks/t1/sessions` and `/tasks/t1/sessions/s9` with `params.taskId` and `params.sessionId`.
- The guard is a named plugin that every child module `.use()`s itself:
  ```ts
  const taskGuard = () =>
    new Elysia({ name: "task.guard" }).resolve({ as: "scoped" }, async ({ params, status }) => {
      const task = await tasksStore.get((params as { taskId: string }).taskId);
      if (!task) return status(404, { error: "task_not_found" });
      return { task };
    });
  ```
  The child handler then receives a typed, non-null `task`; a missing task answers `404 { error: "task_not_found" }` before the handler runs.
- The guard does not leak: parent routes without `:taskId` (`GET /tasks`, `POST /tasks`, and ones registered after the children) are not guarded.
- It runs once per request, even when used in both a `.group("/:taskId")` and a child (deduplicated by `name`).
- Declaring the guard only on the parent also works at runtime, but the child cannot see `task` in its types, and I did not test it against parent routes without `:taskId`. Use it in each child.
- `params` needs a cast inside the plugin, because the plugin has no route path of its own.
- Not covered: the guard in `tasks/sessions` and `tasks/documents` as real modules with real stores, and error mapping through `http/errors.ts`.

**D3 settled: reuse `packages/agents`.** `sessions-store.ts` is a thin adapter over `FirestoreSessionService` from `@stage/agents/session-service`, the same code the jobs use for leases, run state and queued messages, so the lease logic is not duplicated.

D2 and D5 are still open.

## Progress

Done and verified against the local Floci stack (unit tests, the Firestore-backed store tests, and a real run of the API):

- Skeleton: config (`PORT`, `HOST`, optional `EXTRACT_URL`), error mapping, Firestore and extract clients, health.
- `tasks`: create, list, get, delete (cascades to sessions, then releases documents), and `POST /tasks/:taskId/run` (new session or resume, via `platform/cloud-run-jobs-client.ts`; config needs `GCP_PROJECT` and `GCP_REGION`). The failure paths ran against Floci; a real job execution was not started, since the poet and generic jobs call Gemini.
- `tasks/sessions`: list, get, delete, `/stats` and the live `messages` stream (stored events first, then live ones from Pub/Sub when `PUBSUB_TOPIC` is set, `keepalive` events every 5 seconds, using Elysia's native `sse` generator). The stream was run against Floci with a real Pub/Sub message.
- `tasks/documents`: list, get, upload, delete, with 501 when `EXTRACT_URL` is unset.
- `agents` (`/jobs`): list jobs, a job's registered agents, an agent's card, and register. The register route was not run (it executes the job image).
- `events` (`/events`): platform events as SSE, published when tasks, documents and jobs change; 501 without `PLATFORM_EVENTS_TOPIC`. Ran against Floci: a created and a deleted task showed up in the stream.

- Request ids and telemetry: every response carries `x-request-id` (the caller's id if short and plain, else a UUID; also in the error log and on the span). Each request is one OpenTelemetry server span, continuing a caller's `traceparent`, named after the route, with the status, an error status and the exception on 5xx, and the handler's own Firestore and Cloud Run calls as children (Elysia's `wrap` runs the whole pipeline inside the span). Traces are exported only when an `OTEL_EXPORTER_OTLP_*ENDPOINT` is set, through the same `setupTelemetry` the jobs use, registered by `src/telemetry-init.ts` as a `bun --preload` (`start`, `dev`, and the image entrypoint). Checked with a local OTLP receiver: the exported batch had `service.name` `stage-service`, the span `GET /health` and the request id.
- `/docs` (Scalar) and `/openapi.json` (OpenAPI 3.1) from `@elysiajs/openapi`, generated from the routes. The document has the same 15 paths and methods as the Hono service; every operation has a tag, a summary and documented responses (`doc(...)` in `http/openapi.ts`, documentation only, no runtime response validation). The paths are clean (`/tasks`, not `/tasks/`) because the collection routes use `""` under their prefix.

Eden in `apps/ui` (done): `apps/ui/src/lib/api.ts` now builds its `api` object on `treaty<App>` with `App` imported as a type from `@stage/service/app`, so paths, bodies and replies are typed by the service's routes and the UI components did not change (the UI type-checks with no errors). The five server-shape types (`Task`, `DocumentSummary`, `SessionSummary`, `RunState`, `SessionStats`) are derived from the replies; `Job`, `Session`, `SessionEvent`, `AgentInfo` and `JsonSchema` stay UI-shaped (loose views of Cloud Run, ADK and JSON Schema data), and the replies that carry them are cast. Findings: Eden does not encode path parameters, so the facade does (session ids can hold any character); the three `erasableSyntaxOnly` constructs (`event-feed.ts` and the `FirestoreSessionService` constructor) became plain fields; `Dockerfile.ui` copies `packages/agents` and `apps/service` into the build stage for the type check (the image is the same 55 MB, and the bundle grew by 7.9 KB for Eden's runtime); `api.ts` went from 450 to 431 lines, so the gain is type safety, not size. The UI's real `createApi` ran against the live service: health, jobs, agents, create, get, list, upload, detach, delete and the error mapping all passed. Eden types a validation failure as 422 while the service answers 400, and the `run` and `documents` bodies are untyped because those routes read the body themselves.

- The UI type-checks the service sources with its own flags, and `erasableSyntaxOnly` rejects three parameter properties: `service/src/utils/event-feed.ts` and two in `packages/agents/src/session-service.ts` (the `FirestoreSessionService` constructor). Those would have to become plain fields, or the UI would consume emitted `.d.ts` files instead.
- Eden's types say a validation failure is `422`, while the error handler answers 400 `invalid_request`. The documented types and the runtime disagree until that mapping is declared on the routes.
- Rough saving in `apps/ui/src/lib/api.ts` (450 lines): the server-shape types (`Task`, `DocumentSummary`, `Job`, `SessionSummary`, `SessionStats`, `AgentInfo`, `Session`, about 80 lines) and the `api` object with `request` (about 60 lines) would shrink to a small error-mapping helper. That is an estimate, not a migration.

Packaging (Phase 4): `Dockerfile.service` (distroless Bun base, per-workspace production install, non-root UID, `HOST=0.0.0.0`, 221 MB) and `task build:service`. The container ran against Floci: `/health`, `/docs`, `/openapi.json` (15 paths), the Cloud Run job list, creating, reading and deleting a task in Firestore, and the 501 answers without `EXTRACT_URL` and `PLATFORM_EVENTS_TOPIC`.

Terraform: `infra/modules/stage` has an optional `service` Cloud Run service (`deploy_service`, default off), which `infra/envs/local` turns on with the emulator hosts. `terraform validate` passes and `terraform plan` against Floci shows one resource to add and nothing else changing. It has not been applied. `envs/gcp` leaves it off until the service account and IAM are decided (Firestore, Pub/Sub, running the agent jobs with overrides, invoking extract).

Applied to Floci (`task build:service`, then a saved plan with exactly one resource to add): the service runs there as a Cloud Run service, answers `/health` through Floci's URL, lists the jobs through the Cloud Run emulator and reads and writes tasks in Firestore from inside its container. Document upload does not work there: the service container cannot reach extract at the `*.run.localhost.floci.io` address Floci publishes (it resolves to the container's own loopback), so it answers 502 `document_error`; on the host (`bun run dev:service` with the extract URL) it works. `task tf:create-service` and `task tf:remove-service` manage it. Each stream (`messages`, `/events`) now sends a keepalive event at once, because Elysia holds the response headers until the first chunk. The Firestore and Pub/Sub clients take their project from `GCP_PROJECT`, so `GOOGLE_CLOUD_PROJECT` no longer has to be set: without it, the first `/events` request crashed the process (the Pub/Sub client threw `MissingProjectIdError` outside any handler).

GCP (written, validated, not applied): `infra/envs/gcp` can deploy the service with `deploy_service = true`, with a service account and least-privilege IAM listed in `infra/README.md`, and no caller allowed until `service_invokers` names one. The roles came from Google's role documentation through Context7 (`roles/run.jobsExecutorWithOverrides` has `run.jobs.run` and `run.jobs.runWithOverrides`; `roles/run.viewer` lists jobs; creating a subscription needs a project-level permission that only Pub/Sub Editor grants, hence a custom role). Not verified against a project: the exact Pub/Sub permission list, and whether starting an execution needs `iam.serviceAccounts.actAs` on the jobs' runtime account. The service now calls extract with a Google ID token when `EXTRACT_AUDIENCE` is set (`platform/id-token.ts`, tested with a fake auth client; no real token was minted).

Still to do: apply and check that on a real project.

Documentation size: about 250 lines in `service` (the `doc(...)` blocks, `http/openapi.ts` and the response shapes in the models) against the 540 of the hand-written `the Hono service/src/openapi.ts`. The request side (params and bodies) comes from the models for free.

Parity run (Phase 5, first pass): the same 50 requests against both services on the local Floci stack (health, jobs and agents, creating tasks with 10 invalid inputs, reading and deleting, run validation, sessions, documents with a real upload through the extract service, events, unknown routes). **No response differs in status**: 32 are identical, and 18 differ only in the body (the validation error shape and the unknown-route body, listed below). The run found one real bug, fixed in `http/errors.ts`: a body that claims to be JSON but is not answered 502 `internal_error` instead of 400. A real job execution (`run`, `register`) and a live `messages` stream with Pub/Sub events were not part of the comparison; they were checked separately against Floci.

Parity run, second pass (data-bearing scenarios on the shared Floci Firestore, both services running, a real session with events written through `@stage/agents`): sessions list, session detail with state and ordered events, and stats gave identical bodies; the stored event frames of `messages` carry the same ids and data. The `run` paths that never start a job (the job does not exist) behave the same, including `job_error` with the queued message rolled back and the message trimmed, `session_not_found`, `run_in_progress` (lease held), `message_pending` and `task_not_executable`. Session delete (then again), documents (upload twice with one checksum, list, get with content, detach, detach again, and the row released when the task is deleted) and the platform event types for create then delete are identical. The one textual difference is the order of lines inside an SSE event: Hono writes `data:` then `id:`, Elysia writes `id:` then `data:`, which is the same event to any SSE client.

Known differences from the Hono service, to settle in the parity run (Phase 5):

- Validation errors answer 400 `{ error: "invalid_request", details: [{ path, message }] }` (Elysia's 422 is remapped; the old service answers 400 `{ success: false, error: <ZodError> }`). Same status, different body. A body that is not JSON answers 400 `{ error: "invalid_request" }` and the old one a plain text 400. A bad resume answers 400 `{ success: false, error: "invalid_resume" }` without the Zod error object, and is checked before the task lookup, so an invalid resume for an unknown task answers 400 and not 404.
- A prompt is trimmed in the controller, so the 10,000-character limit applies before trimming.
- Unknown routes answer `{ error: "not_found" }`.
- The `messages` stream keepalive is a named `event: keepalive` event, not the `: keepalive` comment line of the Hono service, because Elysia's `sse` helper (id, event, retry, data) has no comments. A browser `EventSource` listening for `message` events never sees it.

## Phases

**Phase 0: spikes.** Settle D1 to D4 with throwaway code in `service`. Output: a short note per decision here. Stop and reassess if D1 and D2 both fail.

**Phase 1: skeleton.**

- `package.json`, `tsconfig` and the workspace entry for `apps/service`.
- `config.ts`: one validated environment schema (same variables as the Hono service).
- `platform/` clients, `http/errors.ts`, `http/request-id.ts`, `http/telemetry.ts`, the `health` module, `index.ts` and `app.ts`.
- Test: `app.handle` on `/health` and an error-mapping case.

**Phase 2: modules, one at a time, each with tests ported from the Hono service.**

1. `tasks` (create, list, get, delete, run) with `tasks-store.ts`.
2. `tasks/documents` (needs `extract-client`).
3. `tasks/sessions` (read, resume with queued message, delete).
4. `agents` (registry, jobs, agent cards).
5. `events` (platform events and session streams as SSE).

**Phase 3: contracts and docs.**

- Generate OpenAPI and serve Scalar and `/openapi.json` (done).
- Export the app type; spike Eden in `apps/ui` on one call, then count the lines removed from `apps/ui/src/lib/api.ts`.

**Phase 4: packaging.**

- `Dockerfile.service` (distroless Bun base like `Dockerfile.service`), `task build:service`.
- Terraform: Cloud Run service, service account, IAM, `EXTRACT_URL` from the extract output, in `infra/modules/stage`.

**Phase 5: parity and decision.**

- Run the same requests against both services and diff status codes and bodies (including the 501 paths when `EXTRACT_URL` or the topic is unset).
- Compare line counts: routes, `openapi.ts` against generated OpenAPI, `api.ts` against Eden.
- Decide: cut over (point `SERVICE_URL` and the UI proxy at the new service, retire the Hono service) or stop and keep Hono. Done: the UI proxy default already points at this service on port 3000, and the Hono service is removed.

## Risks

- Elysia's Zod and OpenAPI support is uncertain (Standard Schema is accepted; OpenAPI from Zod needs a converter and coercion differs from TypeBox). D2 covers it.
- Elysia is Bun-first, so adopting it closes the Deno option.
- Nested plugin behaviour (D1, D4) is not covered by the docs read; the nested layout depends on it.
- Two services to keep in sync while both existed (no longer a risk).

## Not in scope

- New endpoints or behaviour changes. Parity first.
- Authentication, rate limiting and a DI container.
- Changes to the agent jobs or `packages/agents`, except what D3 requires.
