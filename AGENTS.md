# Repository conventions

Tooling rules (Bun instead of Node, `bun test`, and so on) are in [CLAUDE.md](CLAUDE.md). This file holds the naming and layout conventions.

## File naming

- File names are kebab-case: `task-store.ts`, `run-task.ts`. Tests sit next to the file they test and end in `.test.ts`.
- In a layered folder, a file's role is a suffix on its name, singular noun first. The folder alone is not enough, because editors, quick-open and stack traces show only the file name, and the same feature name appears in several layers.

  | Folder      | Pattern                         | Example                                                                      |
  | ----------- | ------------------------------- | ---------------------------------------------------------------------------- |
  | `stores/`   | `<thing>-store.ts`              | `task-store.ts`, `session-store.ts`                                          |
  | `routes/`   | `<feature>-route.ts`            | `task-route.ts`, `job-route.ts`                                              |
  | `usecases/` | named after what it does        | `run-task.ts`, `delete-task.ts`                                              |
  | `platform/` | named after the system it wraps | `cloud-run-jobs-client.ts`, `session-event-stream.ts`, `topic-subscriber.ts` |

- A `*-route.ts` file exports its Hono app as a named export `*Route`, camel-cased from the file name (`task-route.ts` exports `taskRoute`, `session-route.ts` exports `sessionRoute`). It is a factory that takes the dependencies it needs and returns a `new Hono()`, so `app.ts` mounts it with `.route(path, taskRoute(deps))`. No default exports. A route file holds one feature; a second feature gets its own file.
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

`routes` call `usecases` and `stores`; `usecases` call `stores` and `platform`; nothing imports a route. See [apps/service/README.md](apps/service/README.md) for the full layout and how to add an endpoint.

## Code naming

- Factories that build a function or client from dependencies are `createX` (`createGetTask(db)`). Converters between shapes are `toX` (`toContract`, `toSummary`, `toAgentCard`).
- Domain errors end in `Error` (`RunInProgressError`, `DependencyError`). HTTP error codes are snake_case strings (`task_not_found`, `run_in_progress`).
- Do not name a type after a global the platform already has: `EventListener` would shadow the DOM type (the stream callback type is `StreamListener`).
