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

Use `bun test` to run tests.

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

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

# Repository conventions

## File naming

- File names are kebab-case: `task-store.ts`, `task-service.ts`. Tests sit next to the file they test and end in `.test.ts`.
- In a layered folder, a file's role is a suffix on its name, singular noun first. The folder alone is not enough, because editors, quick-open and stack traces show only the file name, and the same feature name appears in several layers.

  | Folder      | Pattern                         | Example                                                                      |
  | ----------- | ------------------------------- | ---------------------------------------------------------------------------- |
  | `stores/`   | `<thing>-store.ts`              | `task-store.ts`, `session-store.ts`                                          |
  | `routes/`   | `<feature>-route.ts`            | `task-route.ts`, `job-route.ts`                                              |
  | `services/` | `<thing>-service.ts`            | `task-service.ts`                                                            |
  | `platform/` | named after the system it wraps | `cloud-run-jobs-client.ts`, `session-event-stream.ts`, `topic-subscriber.ts` |

- A `*-route.ts` file exports its Hono app as a named export `*Route`, camel-cased from the file name (`task-route.ts` exports `taskRoute`, `session-route.ts` exports `sessionRoute`). It is a factory that takes the dependencies it needs and returns a `new Hono()`, so `app.ts` mounts it with `.route(path, taskRoute(deps))`. No default exports. A route file holds one feature; a second feature gets its own file.
- `services/` holds the operations on one thing that need more than one store or platform client, as an object like a store: a type `<Thing>Service`, a factory `create<Thing>Service(deps)`, and one method per operation (`TaskService` has `create`, `run` and `delete`). Each method returns a status for every expected outcome and throws a `DependencyError` when a dependency fails. The word is unrelated to the app `apps/service`: that is the whole HTTP service, and these are objects inside it.
- Apply the rule to the whole folder or not at all. `apps/service` is the only app with layered folders today; a new layered app follows the same patterns.
- Files that hold shared plumbing rather than one role keep a plain name: `errors.ts`, `schemas.ts`, `shared.ts`.

## Stores

A file `<thing>-store.ts` in `stores/` exports one store with the same shape as every other:

- A type `<Thing>Store`: an object of methods, not a bag of separate functions (`TaskStore`, `SessionStore`, `DocumentStore`).
- A factory `create<Thing>Store(db)` that returns it, so a test passes a fake object instead of mocking a module.
- The CRUD verbs are `create`, `list`, `get` and `delete`, with these meanings: `get` returns `undefined` when there is nothing, and `delete` returns a boolean, `false` when there was nothing to delete. Domain operations get their own verb (`queueMessage`, `release`).
- A store throws only the errors of its own domain (`DocumentTooLargeError`); a failing database call is left to the caller, which wraps it in `guard`.

## Platform clients

A file in `platform/` that wraps an external system exports the same kind of object as a store: a type named after the system (`CloudRunJobs`), a factory `create<System>(client, config)`, and methods named for what they do (`list`, `run`, `registerAgents`). Do not export one function type and one factory per operation. The agent registry in `packages/agents` follows the same shape (`AgentRegistry`, `createAgentRegistry(db)`, with `list` and `register`).

## Layout of `apps/service`

`routes` call `services` and `stores`; `services` call `stores` and `platform`; nothing imports a route. See [apps/service/README.md](apps/service/README.md) for the full layout and how to add an endpoint.

## Code naming

- Factories that build a function or client from dependencies are `createX` (`createGetTask(db)`). Converters between shapes are `toX` (`toContract`, `toSummary`, `toAgentCard`).
- Domain errors end in `Error` (`RunInProgressError`, `DependencyError`). HTTP error codes are snake_case strings (`task_not_found`, `run_in_progress`).
- Do not name a type after a global the platform already has: `EventListener` would shadow the DOM type (the stream callback type is `StreamListener`).

## Infrastructure

- Every new cloud resource (Cloud Run job or service, Pub/Sub topic, secret, service account, and so on) is added through Terraform in [infra/](infra/README.md): shared resources in `infra/modules/stage`, and target-specific ones in `infra/envs/local` (Floci) or `infra/envs/gcp`.
- Do not create or change infrastructure with direct Floci or GCP calls: no `curl` against Floci's REST API, no `gcloud` resource commands, no scripts that call the Cloud Run or Pub/Sub APIs to create resources. Direct calls leave resources outside the state and cause 409 `alreadyExists` errors on the next apply.
- Run Terraform through the `tf:*` tasks (`task tf:init`, `task tf:apply`) or `terraform -chdir=infra/envs/<env>`.
- A resource that already exists outside Terraform is adopted with `task tf:import`, not recreated.
- The runtime may still create things on demand (the agent's first publish creates a missing topic, for example). That does not replace declaring the resource in Terraform.
- Direct calls are fine for reading (`task list-jobs`) and for removing a resource from the emulator. Say so and re-run `task tf:apply` afterwards.
