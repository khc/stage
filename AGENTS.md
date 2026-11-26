Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun run test` to run the unit tests. They need no running services.

A test that needs Floci (Firestore) is an integration test. Name its file `<name>.integration.test.ts`, keep its `describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)` guard, and run it with `bun run test:integration` while `docker compose up -d --wait floci-gcp` is running, with `FIRESTORE_EMULATOR_HOST=localhost:4588` and `GOOGLE_CLOUD_PROJECT=floci-local`. `bun run test:all` runs both. CI runs them as separate jobs.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

`apps/ui` is a React SPA built and served with Vite (`bun run dev:ui`); it is the one place Vite is used. Its API types come from the service: `src/lib/api.ts` builds an Eden client from `import type { App } from "@stage/control-service/app"`, so a change to a route is a type error in the UI. A new frontend served by Bun uses HTML imports with `Bun.serve()` instead of adding another Vite app.

Build and change `apps/ui` by the rules in [docs/ui-guidelines.md](docs/ui-guidelines.md): shadcn and AI Elements components only, Data Tables for lists, `Trace` for agent output, color tokens, and the accessibility and responsive checklist. Read it before touching the UI.

# Repository conventions

## File naming

- File names are kebab-case: `tasks-store.ts`, `tasks-service.ts`. Tests sit next to the file they test and end in `.test.ts`. App-level tests that go through `createApp` sit in `src` root (`app.test.ts`).
- `apps/control-service` and `apps/extract-service` are Elysia apps laid out by feature (the latter has one module, `extractions`, plus `health`), following [Elysia's best practice](https://elysiajs.com/essential/best-practice.html) for the folder structure. Each `modules/<module>/` folder holds `<module>-controller.ts` (the Elysia controller), `<module>-service.ts`, `<module>-model.ts` and, where it owns a collection, `<module>-store.ts`. A module's children live inside it (`tasks/sessions/`, `tasks/documents/`).
- A file's role is a suffix on its name, because editors, quick-open and stack traces show only the file name, and the same module name appears in several roles. Files and symbols are named after the module, in the plural, like its folder (`tasks-controller.ts`, `sessions-store.ts`, `TasksService`, `createTasksStore`); `health` has no plural.
- Code that both Elysia apps need lives in `packages/http` (`@stage/http`, imported as `@stage/http/<file>`): `request-id`, `telemetry` (the request span plugin), `otel` (`setupTelemetry`, shared with the agent jobs), `config` (`createConfigLoader`, `serverConfig`, `serverDefaults`) and `errors` (the base `errorHandler`). An app wires them in `createApp` in this order: `requestId()`, `requestTelemetry()`, `.wrap(inRequestSpan)` (Elysia applies `wrap` only on the instance it is called on), then `errorHandler()`. Move code into the package only when a second app needs it, and keep it free of Firestore, GCP and ADK dependencies, so the lighter apps' images stay small.
- Clients of external systems live in `platform/`, named after the system they wrap (`cloud-run-jobs-client.ts`, `firestore-client.ts`, `session-event-stream.ts`, `topic-subscriber.ts`). Cross-cutting Elysia plugins live in `http/`, small helpers in `utils/`, and the entry is `index.ts` with `app.ts`.
- Files that hold shared plumbing rather than one role keep a plain name: `errors.ts`, `config.ts`.

## Services, stores and controllers

- Services, stores and platform clients are factories returning an object of methods, never classes, so a method passed around (`.get("/", service.list)`, destructuring, callbacks) works without `this` binding and a test passes a plain fake object. Each file exports the trio `<Thing>` (the type of the returned object), `<Thing>Deps` (its injected collaborators, exported only when something outside the file needs it) and `create<Thing>(deps)`. A factory with one dependency takes it directly (`createTasksStore(firestore)`); one that also takes plain values uses `(deps, config)`. Named exports only.
- A dependency is named after its type in camelCase: `tasksStore: TasksStore`, `sessionsStore: SessionsStore`, `cloudRunJobs: CloudRunJobs`, `firestore`. Optional ones keep the name.
- A service holds the operations on one thing that need more than one store or platform client, as one method per operation (`TasksService` has `create`, `run` and `delete`). Each method returns a status for every expected outcome and throws a `DependencyError` when a dependency fails; the controller maps statuses to HTTP.
- A store is `<module>-store.ts` in the module that owns the collection. The CRUD verbs are `create`, `list`, `get` and `delete`: `get` returns `undefined` when there is nothing, and `delete` returns a boolean, `false` when there was nothing to delete. Domain operations get their own verb (`queueMessage`, `release`). A store throws only the errors of its own domain (`DocumentTooLargeError`); a failing database call is left to the caller, which wraps it in `guard`.
- A platform client exports a type named after the system (`CloudRunJobs`), a factory `create<System>(client, config)`, and methods named for what they do (`list`, `run`, `registerAgents`). Do not export one function type and one factory per operation. Single-purpose wrappers (`session-event-stream.ts`, `topic-subscriber.ts`) may export one factory for their one operation. The agent registry in `packages/agents` has the same shape (`AgentRegistry`, `createAgentRegistry(firestore)`, with `list` and `register`).
- A controller is an Elysia instance (one per file, a factory taking the services it needs), never a class, mounted with `.use()`; handlers destructure what they need and call the service, and a service never receives Elysia's `Context`. Keep `createApp` one unbroken chain so Eden can read its type, and register `errorHandler` before the routes it covers.
- Schemas live in the module's `<module>-model.ts` (TypeBox, `t` from `elysia`); the OpenAPI document and the UI's types are generated from the routes.

## Layout of `apps/control-service`

Controllers call services (and the module's `tasksGuard`); services call stores and platform clients; stores and platform clients call no module; only a module's parent mounts its controller. Decisions, the parity checks against the Hono service this replaced and what is still open are in [apps/control-service/PLAN.md](apps/control-service/PLAN.md).

## Code naming

- Factories that build a function or client from dependencies are `createX` (`createGetTask(db)`). Converters between shapes are `toX` (`toContract`, `toSummary`, `toAgentCard`).
- Domain errors end in `Error` (`RunInProgressError`, `DependencyError`). HTTP error codes are snake_case strings (`task_not_found`, `run_in_progress`).
- Do not name a type after a global the platform already has: `EventListener` would shadow the DOM type (the stream callback type is `StreamListener`).

## Infrastructure

- Every new cloud resource (Cloud Run job or service, Pub/Sub topic, secret, service account, and so on) is added through Terraform in [infra/](infra/README.md): shared resources in `infra/modules/stage`, and target-specific ones in `infra/envs/local` (Floci) or `infra/envs/gcp`. Follow [docs/naming-rules.md](docs/naming-rules.md) when naming GCP resources, Docker images, and ADK agents.
- Do not create or change infrastructure with direct Floci or GCP calls: no `curl` against Floci's REST API, no `gcloud` resource commands, no scripts that call the Cloud Run or Pub/Sub APIs to create resources. Direct calls leave resources outside the state and cause 409 `alreadyExists` errors on the next apply.
- Run Terraform through the `tf:*` tasks (`task tf:init`, `task tf:apply`) or `terraform -chdir=infra/envs/<env>`.
- A resource that already exists outside Terraform is adopted with `task tf:import`, not recreated.
- The runtime may still create things on demand (the agent's first publish creates a missing topic, for example). That does not replace declaring the resource in Terraform.
- Direct calls are fine for reading (`task list-jobs`) and for removing a resource from the emulator. Say so and re-run `task tf:apply` afterwards.
