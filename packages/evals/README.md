# @stage/evals

End-to-end evals for the agents. Each scenario drives the real control-service API like a client: it
creates a task, runs it with a prompt, follows the session's event stream until the run ends, and
checks what happened per turn (which tools ran, which agents the orchestrator called, what the
answer says). Scenarios are `bun:test` files named `*.eval.ts`, so the root `bun test` never runs
them: they need a running stack and real model calls.

```sh
bun run eval                 # from the repo root: every src/scenarios/*.eval.ts
EVAL_REPEAT=5 bun run eval   # run each scenario 5 times (see the pass rate)
```

## Prerequisites

- The local stack is up and the agents are registered (`task register-agents`).
- The IMDb data and the Neo4j graph are loaded, for the `discovery-assistant` scenarios.
- `EXA_API_KEY` is set **where the knowledge agents run** (the knowledge job or service), not for
  `bun run eval`: the eval process only calls the control-service API.

## Environment (the eval process)

| Variable      | Default                         | Meaning                                                                 |
| ------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `SERVICE_URL` | `http://localhost:3000`         | The control-service. Export it in the shell: no `.env` is read.         |
| `EVAL_ENV`    | `lcl`                           | Environment suffix of the job names (`stage--<app>-agents--job-<env>`). |
| `EVAL_REPEAT` | the scenario's `repeat`, else 1 | Runs per scenario.                                                      |
| `EVAL_KEEP`   | unset                           | `1` keeps each run's task, for debugging.                               |
| `EVAL_CLEAN`  | unset                           | `1` first deletes the leftover `eval:` tasks of a killed or kept run.   |

## Adding a scenario

Create `src/scenarios/<name>.eval.ts`:

```ts
import { defineScenario } from "../scenario";

defineScenario({
  name: "imdb-then-web",
  app: "knowledge",
  agent: "discovery-assistant",
  repeat: 5,
  minPassRate: 0.8, // 4 of 5 runs must pass
  turns: [
    { say: "What is the cast of Friends?", expect: { toolsExclude: ["search_web"] } },
    { say: "Where does she live?", expect: { toolsInclude: ["search_web"] } },
  ],
});
```

A turn's `expect` takes `tools`, `toolsInclude`, `toolsExclude`, `delegatedTo`, `delegatedToOneOf`,
`calls` (a check on a whole tool call, response included), `custom`, `answerIncludes`,
`answerMatches` and `maxCalls` (see `src/checks.ts`). Scenarios run in `quick` mode unless they set
`mode: "workflow"`.

A failing scenario lists each failed run with its task id. Run it with `EVAL_KEEP=1` to keep the
task and look at its session in the UI.
