# service2 plan

An Elysia rebuild of the HTTP service (`apps/service`), laid out by feature and driven by the platform's shape, not by the Hono code. `apps/service` stays the reference and keeps running until service2 reaches parity.

## Goal

- Same API as `apps/service`: same routes, status codes and error codes (`task_not_found`, `run_in_progress`, ...), so `apps/ui` and the agent jobs work unchanged.
- Less code to maintain: schemas written once (`packages/contracts`), OpenAPI generated from the routes, UI types from the routes (Eden) instead of hand-written ones.
- Decide with evidence whether Elysia replaces Hono. Phase 0 and the parity phase produce that evidence; this plan does not assume the answer.

## Platform facts that shape the design

- The service is a thin control plane: it creates tasks, starts Cloud Run Job executions, reads Firestore and relays Pub/Sub as SSE. The agent jobs do the work.
- Firestore documents (tasks, sessions, agent registry, run leases) are a contract shared with the jobs, which write them through `packages/agents`.
- A run is asynchronous: `/run` returns once the execution is started; progress arrives by polling or SSE. Firestore is the source of truth, Pub/Sub is best effort.
- Every GCP system is reached through a client configured only by environment variables (Floci locally, real GCP in production).
- The service is not in Terraform today; the jobs, extract and topics are.

## Layout

```
apps/service2/src/
  index.ts  app.ts  config.ts
  http/        errors.ts  request-id.ts  telemetry.ts       # cross-cutting plugins
  platform/    firestore-client.ts  cloud-run-jobs-client.ts  pubsub-client.ts  extract-client.ts
  modules/
    tasks/     tasks-controller.ts  tasks-service.ts  tasks-model.ts  tasks-store.ts
      sessions/    sessions-controller.ts  sessions-service.ts  sessions-model.ts  sessions-store.ts
      documents/   documents-controller.ts  documents-service.ts  documents-model.ts  documents-store.ts
    agents/  events/  health/        # <module>-controller.ts  <module>-service.ts  <module>-model.ts each
packages/contracts/src/  task.ts  session.ts  event.ts  agent-spec.ts
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

| #   | Question                                                                                                                                                                                                                                                                                        | How to settle it                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Settled, see Spike results.** Can the tasks controller resolve `:taskId` once for the nested sessions and documents plugins, so children need no task store or 404 check? The Elysia pages read say plugins do not inherit lifecycle hooks by default and `guard` does not support `resolve`. | Spike: a named `task.guard` plugin with `.resolve({ as: "scoped" }, ...)` that each child `.use()`s; test the 404 with `app.handle(new Request(...))`. Fallback: inject an `exists(taskId)` call from the tasks service.   |
| D2  | How do `packages/contracts` (Zod, shared with the jobs and UI) and each `<module>-model.ts` (Elysia's guide uses TypeBox) split the work?                                                                                                                                                       | Rule to test: contracts own the wire schemas; `model.ts` only composes route params and bodies. Check OpenAPI output and coercion for one route; use namespaced model names (`tasks.sessions.*`) because duplicates throw. |
| D3  | **Settled: reuse.** Does `tasks/sessions` keep its own store or reuse the session logic in `packages/agents` that the jobs use (leases, `runId` fencing)?                                                                                                                                       | Compare `session-store` in `apps/service` with `packages/agents/src/session-service.ts`; prefer importing the shared code over duplicating lease logic.                                                                    |
| D4  | **Settled, yes.** Does a dynamic prefix (`/:taskId/sessions`) work in nested plugins?                                                                                                                                                                                                           | Part of the D1 spike.                                                                                                                                                                                                      |
| D5  | DI container?                                                                                                                                                                                                                                                                                   | No. Revisit only if the wiring in `index.ts` outgrows one screen or request-scoped instances are needed (try `derive`/`resolve` first).                                                                                    |

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

- `/docs` (Scalar) and `/openapi.json` (OpenAPI 3.1) from `@elysiajs/openapi`, generated from the routes. The document has the same 15 paths and methods as `apps/service`; every operation has a tag, a summary and documented responses (`doc(...)` in `http/openapi.ts`, documentation only, no runtime response validation). The paths are clean (`/tasks`, not `/tasks/`) because the collection routes use `""` under their prefix.

Still to do: the D2 decision (below), Eden in `apps/ui` (Phase 3), then Phases 4 and 5.

Documentation size: about 250 lines in `service2` (the `doc(...)` blocks, `http/openapi.ts` and the response shapes in the models) against the 540 of the hand-written `apps/service/src/openapi.ts`. The request side (params and bodies) comes from the models for free.

Known differences from `apps/service`, to settle in the parity run (Phase 5):

- Validation errors answer 400 `{ error: "invalid_request", details }` (Elysia's 422 is remapped; `details` exposes schema internals). A bad resume answers 400 `{ success: false, error: "invalid_resume" }` without the Zod error object, and is checked before the task lookup, so an invalid resume for an unknown task answers 400 and not 404.
- A prompt is trimmed in the controller, so the 10,000-character limit applies before trimming.
- Unknown routes answer `{ error: "not_found" }`.
- The `messages` stream keepalive is a named `event: keepalive` event, not the `: keepalive` comment line of `apps/service`, because Elysia's `sse` helper (id, event, retry, data) has no comments. A browser `EventSource` listening for `message` events never sees it.

## Phases

**Phase 0: spikes.** Settle D1 to D4 with throwaway code in `service2`. Output: a short note per decision here. Stop and reassess if D1 and D2 both fail.

**Phase 1: skeleton.**

- `package.json`, `tsconfig`, workspace entry for `apps/service2` and `packages/contracts`.
- `config.ts`: one validated environment schema (same variables as `apps/service`).
- `platform/` clients, `http/errors.ts`, `http/request-id.ts`, `http/telemetry.ts`, the `health` module, `index.ts` and `app.ts`.
- Test: `app.handle` on `/health` and an error-mapping case.

**Phase 2: modules, one at a time, each with tests ported from `apps/service`.**

1. `tasks` (create, list, get, delete, run) with `tasks-store.ts`.
2. `tasks/documents` (needs `extract-client`).
3. `tasks/sessions` (read, resume with queued message, delete).
4. `agents` (registry, jobs, agent cards).
5. `events` (platform events and session streams as SSE).

**Phase 3: contracts and docs.**

- Move shared schemas into `packages/contracts`; generate OpenAPI; serve Scalar and `/openapi.json`.
- Export the app type; spike Eden in `apps/ui` on one call, then count the lines removed from `apps/ui/src/lib/api.ts`.

**Phase 4: packaging.**

- `Dockerfile.service2` (distroless Bun base like `Dockerfile.service`), `task build:service2`.
- Terraform: Cloud Run service, service account, IAM, `EXTRACT_URL` from the extract output, in `infra/modules/stage`.

**Phase 5: parity and decision.**

- Run the same requests against both services and diff status codes and bodies (including the 501 paths when `EXTRACT_URL` or the topic is unset).
- Compare line counts: routes, `openapi.ts` against generated OpenAPI, `api.ts` against Eden.
- Decide: cut over (point `SERVICE_URL` and the UI proxy at service2, retire `apps/service`) or stop and keep Hono.

## Risks

- Elysia's Zod and OpenAPI support is uncertain (Standard Schema is accepted; OpenAPI from Zod needs a converter and coercion differs from TypeBox). D2 covers it.
- Elysia is Bun-first, so adopting it closes the Deno option.
- Nested plugin behaviour (D1, D4) is not covered by the docs read; the nested layout depends on it.
- Two services to keep in sync while both exist; limit changes to `apps/service` during the rebuild.

## Not in scope

- New endpoints or behaviour changes. Parity first.
- Authentication, rate limiting and a DI container.
- Changes to the agent jobs or `packages/agents`, except what D3 requires.
