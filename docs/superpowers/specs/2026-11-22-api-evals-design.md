# End-to-end agent evals through the API: design

Status: draft for approval. Date: 2026-11-22.

## Intent

When an agent's prompt, tools or model change, there is no way to tell whether the agent still
behaves. The unit tests fake the model. Nothing runs a real agent end to end and asks whether it
picked the right tool, the right sub-agent, and gave a good answer.

Build a suite of end-to-end evals that drive the real control-service API the way a client does:
create a task, run it with a prompt, follow the session's event stream until the run ends, then
score what happened. The author is tuning agents (for example `discovery-assistant`, which must
try IMDb first and only then `search_web`), so the suite has to show whether a prompt change moved
the pass rate, not only whether one run passed.

## Goals

- Two scenario kinds, described by the author in typed TypeScript:
  1. **Orchestration:** one prompt to `orchestrator`; check which agent(s) it delegated to, and
     the answer.
  2. **Multi-turn on one agent:** two or more prompts on one session; check, per turn, which
     tools ran, in what order, with what arguments, and the answer. The motivating case is
     `discovery-assistant`: turn 1 uses IMDb tools and no `search_web`; turn 2 uses `search_web`.
- Checks are of two kinds: **deterministic** (tool names, order, arguments, delegated agents, the
  number of calls) and **judged** (a model grades the answer against a short rubric).
- Each scenario can run N times and reports a pass rate; two runs can be compared.
- Runs locally, against the local stack only, with one command that is not part of `bun test`.

## Non-goals

- No UI, no browser. No unit tests of agents (the `*.test.ts` files stay as they are).
- No deployed (Cloud Run / GCP) target in this version, so no ID-token auth.
- No production tracing or monitoring of live traffic.
- No CI gating yet: the suite needs a running stack, real model calls and an Exa key.
- No new infrastructure. The evals only call the existing API (so nothing goes through Terraform).

## Anti-goals (would make this a failure even if it works)

- A suite so flaky that nobody trusts a red result. Strict checks must be on things the code
  guarantees (for example, `search_web` is refused after an internal tool in the same turn). Soft
  checks go on model-written text.
- Scoring turn 2 with turn 1's answer because the harness read the session before the new run
  started.
- Eval tasks left behind in the local database.

## Constraints from the code

- `POST /tasks` creates the task (201). `POST /tasks/:id/run` with `{message, sessionId?, mode?}`
  starts a session or resumes one (202, returns `sessionId`). A run in progress answers 409
  (`run_in_progress`, `message_pending`).
- `GET /tasks/:id/sessions/:sid/messages` is Server-Sent Events: stored events first, then live
  ones, each with an id, and a `keepalive` event every 5 s when idle. Each event's data is the JSON
  of one ADK event. It has no explicit end marker.
- A session's `run.status` is `running`, `succeeded` or `failed` (a stalled run counts as
  `failed`). After a resume the session still shows the **previous** run until the new one starts,
  so the end of a turn is: `run.startedAt` differs from the previous turn's, and `status` is not
  `running`.
- Events of one turn share an `invocationId`. A turn's tool calls are the `functionCall` and
  `functionResponse` parts of the events with that id.
- Delegation: the orchestrator calls agents over A2A. The gateway creates a child task with
  `parentTaskId` and `parentSessionId`. `GET /tasks` has no filter, so children are found by
  filtering the list.
- `DELETE /tasks/:id` removes a task with its sub-tasks and sessions.
- Repository rules that apply: Bun only (`bun run`, `bunx`), kebab-case file names, named exports,
  factories not classes, the typed client comes from `import type { App } from
  "@stage/control-service/app"` as `apps/ui` does, and a new dependency needs a reason.

## Approaches considered

1. **`bun test` files (`*.eval.ts`) with threshold asserts.** Least code, no new dependency. Each
   case is pass or fail; no scores, no comparison between runs. Weak for prompt tuning.
2. **Own small Bun CLI** (`--repeat N`, JSON results, a compare command). No dependency. About 100
   more lines to write and keep, and no results viewer.
3. **Promptfoo on top of a shared trace client.** Gives repeats, a score per case, llm-rubric
   judging, run comparison and a viewer. Adds one dependency, and a judge model needs a key.

Chosen (my call, the author did not object when it was proposed): **3**, with the work split so that
2 stays a cheap fallback. The trace client and the checks are plain Bun/TypeScript with no
Promptfoo imports. Promptfoo is a thin adapter around them.

Rejected: ADK's own eval (it runs the agent in-process and skips the API, SSE and Firestore path
that this suite exists to test); Braintrust (hosted and paid, and agent outputs would leave the
machine); Langfuse (more than is needed now); Evalite (built on vitest, which this repo avoids);
DeepEval, RAGAS, LangSmith and Phoenix (Python or hosted).

## Design

The harness is the workspace package `packages/evals` (`@stage/evals`); the scenarios and the golden
data are the workspace package `evals/` at the repo root (`@stage/eval-suite`). Files are kebab-case.
As built, the scenarios are `bun:test` files (`*.eval.ts`); the Promptfoo adapter drawn in the first
version of this layout was not built.

```
packages/evals/src/   harness
  api-client.ts       createApiClient(baseUrl): typed Eden client + SSE reader
  sse.ts              pure Server-Sent Events parser
  run-scenario.ts     create task, play each turn on one session, collect the trace, clean up
  trace.ts            Trace and Turn types; toolCalls(events), finalAnswer(events)
  checks.ts           deterministic checks on a Turn (pure functions)
  scenario.ts         defineScenario, repeat and pass rate, EVAL_* settings
evals/                scenarios and golden data
  scenarios/          orchestrator.eval.ts, discovery.eval.ts, search-guard.ts, ...
  golden/cases.json   reference facts, with IMDb ids and web sources
  golden.test.ts      keeps the golden file in step with the scenarios
```

**Data model (sketch).**

```ts
type Expect = {
  tools?: string[]; // exactly these tools called, in order, this turn
  toolsInclude?: string[]; // at least these
  toolsExclude?: string[]; // none of these
  delegatedTo?: string[]; // agents the orchestrator called (from child tasks)
  args?: { tool: string; match: (args: unknown) => boolean }[];
  judge?: string; // rubric for the answer, graded by the judge model
};
type Scenario = {
  name: string;
  agent: string; // the task's agentName
  mode?: "quick" | "workflow"; // default "quick" (my call: faster, no job to start locally)
  turns: { say: string; expect: Expect }[];
};
```

**Flow of `runScenario`.**

1. `POST /tasks` with the scenario's agent and a name prefixed `eval:`.
2. For each turn: `POST /tasks/:id/run` with the message (and the `sessionId` after turn 1). On
   409, wait and retry. Open the SSE stream and collect events until the turn has ended (the run
   rule in "Constraints"). Poll `GET .../sessions/:sid` for the run status; the stream is for the
   trace and the poll decides the end.
3. Group events by `invocationId` into the turn's events. Read the final answer from the last
   model event of the turn.
4. For the orchestrator: list tasks, keep those whose `parentTaskId` is the root task, and fetch
   each child's session, so the trace holds the whole task tree.
5. Return the `Trace`. Delete the root task unless `--keep` is set.

**Checks.** `checks.ts` turns an `Expect` and a `Turn` into a list of failures. The deterministic
ones run in-process. `judge` is handed to Promptfoo's `llm-rubric`.

**Scenarios to ship first (the author's):**

- Orchestrator: a question the IMDb agent answers; check `delegatedTo`, then the answer.
- `discovery-assistant`, two turns: "What is the cast of Friends?" (internal tools, no
  `search_web`) then "Where does she live?" (`search_web` once, the query names the person and
  does not contain "she").
- `discovery-assistant`, prefixed line: a `Web search:` first line is honoured: `search_web` is never
  refused with `web_search_query_required`, even after an internal tool returned data. That the tool
  sends exactly the prefixed text is not observable through the API (the call's arguments hold the
  model's own query), so it stays covered by `agents/knowledge/src/discovery-agent.test.ts`.
- `discovery-assistant`, blocked search: after an internal tool returns data, `search_web` is
  refused and the agent asks for a `Web search:` line, not a retry.

**Running.** `bun run eval` (root script, which runs Promptfoo through `bunx`) with `SERVICE_URL`
defaulting to `http://localhost:3000`. `--repeat N` sets the runs per scenario. The first
implementation task is a spike to check that Promptfoo runs under Bun with a TypeScript provider;
if it does not, build the Bun CLI of approach 2 around the same client and checks.

**Prerequisites (documented in the README, checked at start).** The local stack is up and the
agents are registered; the IMDb data and the Neo4j graph are loaded; `EXA_API_KEY` is set for the
`search_web` scenarios; a judge model key is set. The runner checks that the service answers
`/health` before it starts.

## Left to the builder

- Exact event field paths for tool calls and the final answer (read a real session first).
- Wait and retry timings, and the per-turn timeout.
- Whether the Promptfoo config can be TypeScript or must be YAML plus a JS provider.
- Naming of the root script and a Taskfile entry.

## Open for the author

- **Judge model:** which provider and model grades the `judge` rubrics? It can be the same one the
  agents use, or a stronger one. A judge that is the model under test is a weak judge.
- **Default mode:** `quick` is assumed. Say if the scenarios should run as `workflow` too.
