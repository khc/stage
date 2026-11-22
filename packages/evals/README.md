# @stage/evals

The harness behind the evals. The scenarios and the golden data are in `evals/` at the repo root
(`@stage/eval-suite`), and its README says how to run them.

A scenario drives the real control-service API like a client: it creates a task, runs it with a
prompt, follows the session's event stream until the run ends, and checks what happened per turn.

| Module            | Role                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenario.ts`     | `defineScenario`: registers one `bun:test` test that runs a scenario `repeat` times and passes at `minPassRate`; reads the `EVAL_*` settings |
| `run-scenario.ts` | creates the task (named `eval: <scenario> (<id>)`), plays each turn on one session, waits for the run to end, deletes the task               |
| `api-client.ts`   | typed client for the control-service routes (Eden), plus the SSE stream                                                                      |
| `sse.ts`          | pure Server-Sent Events parser                                                                                                               |
| `trace.ts`        | turns the session's events into tool calls and an answer                                                                                     |
| `checks.ts`       | the deterministic checks a turn's `expect` can use                                                                                           |

Scenarios import `@stage/evals/scenario` and `@stage/evals/trace`. The unit tests here use a fake
API and need no running stack: `bun test packages/evals`.
