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
    tasks/     controller.ts  service.ts  model.ts  task-store.ts
      sessions/    controller.ts  service.ts  model.ts  session-store.ts
      documents/   controller.ts  service.ts  model.ts  document-store.ts
    agents/  events/  health/        # controller.ts  service.ts  model.ts each
packages/contracts/src/  task.ts  session.ts  event.ts  agent-spec.ts
```

Rules:

- One Elysia instance per controller (`controller.ts`; Elysia's guide calls it `index.ts`, we use the clearer name), mounted with `.use()`. Handlers destructure what they need and call the service; the service never receives Elysia's `Context`.
- Services, stores and platform clients are factories, not classes, so a method passed around (`.get("/", service.list)`, destructuring, callbacks) keeps working without `this` binding, and tests pass plain fake objects. Controllers are always Elysia instances, never classes.
- Each one is a trio per file: `<Thing>` (the type of the returned object), `<Thing>Deps` (its injected collaborators) and `create<Thing>(deps)`. Named exports only. Export `<Thing>Deps` only when something outside the file needs it. A factory with a single dependency skips the type: `createTaskStore(db)`.
- A dependency is named after its type in camelCase: `taskStore: TaskStore`, `sessionStore: SessionStore`, `documentStore: DocumentStore`, `cloudRunJobs: CloudRunJobs`. Optional ones keep the name (`documentStore?: DocumentStore`). Plain config values (`topic`, `region`) are not dependencies and are named for what they hold. A factory that takes both uses `(deps, config)`.
- Services are `create<Thing>Service(deps)` factories returning an object with one method per operation. Each returns a status for every expected outcome and throws `DependencyError` when a dependency fails.
- Stores are `create<Thing>Store(db)` and live in the module that owns the collection. Tasks is the aggregate root: sessions and documents are keyed by `taskId`, nested under it, and reached by the tasks service inside its own folder.
- URLs come from each instance's `prefix`, not from folders (`/tasks`, then `/:taskId/sessions`, `/:taskId/documents`).
- `platform/` clients are named after the system they wrap, take `(client, config)`, and are passed in explicitly. `index.ts` builds them once and calls `createApp(deps)`. No DI container for now.
- Routes are one unbroken chain, and `createApp` exports its type, or Eden loses its types.
- Register `onError` (from `http/errors.ts`) before the routes it covers.
- Naming and file rules are in [AGENTS.md](../../AGENTS.md), including the exception for this app.

## Open decisions (settle in Phase 0)

| #   | Question                                                                                                                                                                                                                                                        | How to settle it                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Can the tasks controller resolve `:taskId` once for the nested sessions and documents plugins, so children need no task store or 404 check? The Elysia pages read say plugins do not inherit lifecycle hooks by default and `guard` does not support `resolve`. | Spike: a named `task.guard` plugin with `.resolve({ as: "scoped" }, ...)` that each child `.use()`s; test the 404 with `app.handle(new Request(...))`. Fallback: inject an `exists(taskId)` call from the tasks service.   |
| D2  | How do `packages/contracts` (Zod, shared with the jobs and UI) and each `model.ts` (Elysia's guide uses TypeBox) split the work?                                                                                                                                | Rule to test: contracts own the wire schemas; `model.ts` only composes route params and bodies. Check OpenAPI output and coercion for one route; use namespaced model names (`tasks.sessions.*`) because duplicates throw. |
| D3  | Does `tasks/sessions` keep its own store or reuse the session logic in `packages/agents` that the jobs use (leases, `runId` fencing)?                                                                                                                           | Compare `session-store` in `apps/service` with `packages/agents/src/session-service.ts`; prefer importing the shared code over duplicating lease logic.                                                                    |
| D4  | Does a dynamic prefix (`/:taskId/sessions`) work in nested plugins?                                                                                                                                                                                             | Part of the D1 spike.                                                                                                                                                                                                      |
| D5  | DI container?                                                                                                                                                                                                                                                   | No. Revisit only if the wiring in `index.ts` outgrows one screen or request-scoped instances are needed (try `derive`/`resolve` first).                                                                                    |

## Phases

**Phase 0: spikes.** Settle D1 to D4 with throwaway code in `service2`. Output: a short note per decision here. Stop and reassess if D1 and D2 both fail.

**Phase 1: skeleton.**

- `package.json`, `tsconfig`, workspace entry for `apps/service2` and `packages/contracts`.
- `config.ts`: one validated environment schema (same variables as `apps/service`).
- `platform/` clients, `http/errors.ts`, `http/request-id.ts`, `http/telemetry.ts`, the `health` module, `index.ts` and `app.ts`.
- Test: `app.handle` on `/health` and an error-mapping case.

**Phase 2: modules, one at a time, each with tests ported from `apps/service`.**

1. `tasks` (create, list, get, delete, run) with `task-store.ts`.
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
