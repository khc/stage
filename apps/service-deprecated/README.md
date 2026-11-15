# @stage/service

The HTTP API of Stage: a [Hono](https://hono.dev) app on Bun that stores tasks, starts Cloud Run Jobs for them, and exposes their sessions, documents and live events. The route reference, request and response shapes live in the [root README](../../README.md#tasks) and at `/docs` (Scalar) and `/openapi.json` when the service runs. This file is about how the service is built.

## Run it

```bash
bun run dev:service-deprecated      # from the repository root: http://localhost:3001, reloads on change
bun run --filter @stage/service start
bun run typecheck        # the whole repo; or: bun --filter @stage/service typecheck
bun test apps/service-deprecated    # the service tests
```

The scripts load the repository-root `.env`. Point the service at the local emulator (Floci) with `FIRESTORE_EMULATOR_HOST=localhost:4588`, `CLOUD_RUN_EMULATOR_HOST=localhost:4588` and `PUBSUB_EMULATOR_HOST=localhost:4588`. Without them it uses the real Google Cloud APIs and Application Default Credentials.

### Configuration

| Variable                    | Required | Meaning                                                                                          |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `GCP_PROJECT`, `GCP_REGION` | yes      | The project and region whose Cloud Run Jobs are used. The service fails at startup without them. |
| `PORT`                      | no       | Listen port, default `3001` (`apps/service` has `3000`).                                         |
| `FIRESTORE_EMULATOR_HOST`   | no       | Use the Firestore emulator.                                                                      |
| `CLOUD_RUN_EMULATOR_HOST`   | no       | Use the Cloud Run emulator (REST, no credentials), as `host:port`.                               |
| `PUBSUB_TOPIC`              | no       | Topic the agents publish their events to. Makes `/tasks/:id/sessions/:id/messages` live.         |
| `PLATFORM_EVENTS_TOPIC`     | no       | Topic for the service's own events (task created, run requested, …). Turns on `/events`.         |
| `EXTRACT_URL`               | no       | Base URL of `apps/extract`. Turns on document upload.                                            |

Without `PLATFORM_EVENTS_TOPIC` the `/events` route and without `EXTRACT_URL` the document routes answer `501 not_supported`. Without `PUBSUB_TOPIC` the messages stream still replays the stored events but sends nothing live.

## Layout

```
src/
  index.ts        composition root: reads the environment, builds the stores and clients, calls createApp
  app.ts          createApp(deps): mounts the route modules, maps errors to HTTP
  routes/         one Hono app per feature, mounted with app.route()
  services/       operations that span several stores or sources: task-service (create, run, delete),
                  session-service (the message stream), platform-event-service, and event-feed,
                  the helper both streams use
  stores/         Firestore access, one store per thing: task, session, document
  platform/       Cloud Run, Pub/Sub listeners, platform-event publisher
  utils/          pure helpers with no dependencies on the layers: session-stats (token usage of a session)
  errors.ts       DependencyError and guard()
  schemas.ts      request validation (zod)
  openapi.ts      the hand-written OpenAPI document
```

Dependencies point downwards: `routes` use `services` and `stores`, `services` use `stores` and `platform`, and nothing imports a route. Tests sit next to the file they test. Files in the layered folders carry their role as a suffix: `stores/task-store.ts`, `routes/task-route.ts`, and `platform/cloud-run-jobs.ts` for the one that would otherwise repeat a route name. A service is an object like a store: `services/task-service.ts` exports `TaskService` and `createTaskService(deps)`, with one method per operation.

### Dependency injection

`createApp` takes one `Deps` object (see `app.ts`): the stores and clients it needs (`tasks`, `sessions`, `jobs`, `registry`), plus the optional features (`documents`, `sessionEventStream`, `platformEventStream`). Each is an object of methods built by a factory (`createTaskStore(db)`, `createCloudRunJobs(client, config)`), so a test passes a fake object instead of mocking a module. `app.test.ts` has a `buildApp(overrides)` helper that starts from stubs.

### Routes

Each file in `routes/` is named `<feature>-route.ts` and exports one `<feature>Route` factory (`taskRoute(deps)`) that returns a chained `new Hono()` with paths relative to where it is mounted (`/jobs`, `/tasks`). Handlers stay inline right after their path, as the [Hono guide](https://hono.dev/docs/guides/best-practices#building-a-larger-application) recommends, so path parameters keep their types. A handler parses the request, calls a store or a service, and maps the result to a status code.

### Errors

Expected outcomes (not found, conflict, too large) are returned where they happen, as `c.json({ error: "code" }, status)`. A failing dependency (Firestore, Cloud Run, Pub/Sub) is not handled in the route: wrap the call in `guard("task_error", () => …)`, which throws a `DependencyError`. `app.onError` turns it into `502 { error: "task_error" }` and logs the cause, so callers never see storage details.

## Adding an endpoint

1. Add the handler to the matching file in `routes/` (or a new file mounted in `app.ts`), validating params with `zValidator` and a schema from `schemas.ts`.
2. If it touches more than one store, put the logic in `services/` and return a status for each expected outcome.
3. Add the operation to `openapi.ts`. `openapi.test.ts` fails when a route and the document disagree.
4. Add tests: a service test for the logic and an `app.test.ts` case for the HTTP mapping.

## Tests

```bash
bun test apps/service-deprecated
FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local bun test apps/service-deprecated/src/stores
```

Most tests use fakes. The store tests that talk to Firestore run only when `FIRESTORE_EMULATOR_HOST` is set (start the emulator with `docker compose up -d`) and are skipped otherwise.
