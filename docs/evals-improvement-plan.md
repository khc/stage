# Evals improvement plan

Status: draft, 2026-11-22. This is a roadmap, not an approved implementation plan: each item gets its
own plan (`$dot:plan`) when it is picked up. The evals themselves are described in
[evals/README.md](../evals/README.md) and the original design in
[the design doc](superpowers/specs/2026-11-22-api-evals-design.md).

## Where we are

- The harness (`packages/evals`) drives the real control-service API: it creates a task, runs it for
  one or more turns, follows the session's event stream, and checks each turn. The scenarios and the
  golden data live in `evals/`.
- Four scenarios run on the local stack. At the last full run (2026-11-22) the discovery scenarios
  passed after the turn-2 check was relaxed (the first one 5/5, blocked search 4/5, Web search line
  5/5), and the orchestrator scenario failed: the orchestrator chose `workflow` mode, so its answer
  was only a task receipt.
- `evals/golden/cases.json` holds reference facts, but the scenarios do not read it yet; they
  hard-code "Aniston" and "Michael Mann".
- Every check is deterministic: tool names and order, call arguments and responses, and exact
  (case-insensitive) text in the answer.

## Principle: layered scoring

Each layer catches what the others miss. The deterministic layer stays the gate for facts.

| Layer                                                         | Catches                                                                                                 | Misses                                                                                              | Cost                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1. Deterministic (tools, required text, now with fuzzy names) | exact facts, which tools ran, call counts                                                               | paraphrase, anything that cannot be written as a string                                             | free                                                  |
| 2. Embedding similarity                                       | off-topic, empty or wrong-type answers (a "workflow started" receipt), drift between runs               | wrong names, numbers and negation: "Courteney Cox plays Rachel" scores almost like the right answer | one embedding call per turn                           |
| 3. LLM judge (rubric plus golden facts)                       | wrong or missing facts, contradictions, acceptable alternatives such as "asks for a `Web search:` line" | in principle nothing, but the judge itself can be wrong                                             | one model call per turn, slower, not fully repeatable |

Layers 2 and 3 start as reported scores. A layer becomes a gate only after it has been calibrated
against answers whose verdict is known.

## Work items, in suggested order

### 1. Wire the scenarios to the golden data

- **Why:** the facts live in two places today. A change to one is silently missed by the other.
- **What:** scenarios read `mustInclude` and the prompt from `evals/golden/cases.json` by case id.
  A volatile case past its `reviewBy` date prints a warning at the start of a run (not a failure).
- **Done when:** no fact is hard-coded in a `*.eval.ts` file; `golden.test.ts` still passes; a test
  shows the warning for an overdue case.

### 2. Tell infrastructure failures from agent failures

- **Why:** the Vertex 429 quota errors counted as wrong answers and made pass rates meaningless.
- **What:** a run whose failed event has `errorCode: "429"` (or another provider-side code) is
  "inconclusive": retried once after a pause, and if it stays inconclusive it is left out of the pass
  rate. The report says "N of M runs hit the model quota". A scenario with no conclusive run fails
  with that message, not with a pass rate.
- **Done when:** unit tests with a fake API cover retry, exclusion and the all-inconclusive case.

### 3. Fuzzy names in the factual layer (Levenshtein)

- **Why:** `answerIncludes` fails a correct answer that spells "Courtney Cox" or "Matt Leblanc".
- **What:** a name listed in the golden `mustInclude` matches when the answer holds a substring within
  edit distance 1 of it, after lowercasing and stripping accents, but only for names of 8 or more
  characters; shorter names stay exact. About 15 lines, no dependency (the repo has no edit-distance
  helper). The same match serves the "query names Aniston" check.
- **Not for:** whole answers (length dominates the distance) or short names (one letter is a
  different person).
- **Done when:** tests accept "Courtney Cox" and "Michael Mann" with one typo, and reject "Michael
  Moon" and a wrong cast member.

### 4. Decide the orchestrator scenario

- **Why:** it fails for a behaviour reason, and nobody has ruled on it.
- **Options:** (a) keep it failing, as a record that the orchestrator should pick `quick` for a
  lookup, and fix the orchestrator prompt; (b) change the scenario's prompt to ask for a quick
  answer; (c) accept a `workflow` receipt and follow the child task. Also decide whether it runs on
  mercury-3 like the discovery scenarios.
- **Needs:** the author's decision before any work.

### 5. LLM judge (layer 3)

- **Why:** it is the most accurate check for correctness and for open-ended or volatile answers.
- **What:** a judge prompt receives the question, the answer, the golden facts and the acceptable
  outcomes, and returns pass or fail with one reason. Rules: a model different from the agent's; the
  golden data is the only reference (the judge must not grade from its own knowledge); the model is
  pinned in one place; the judge's verdict and reason are stored with the run.
- **Calibration:** run it on known-right and known-wrong answers (the golden set plus a few wrong
  ones, such as a different actress) before it gates anything.
- **Needs:** which saved provider and model grades. The harness only talks to the control-service
  API today, so how the judge reaches a model (a new route, or a key in the eval process) is part of
  its plan.

### 6. Embedding similarity (layer 2)

- **Why:** a cheap, steady signal for drift and wrong-type answers, and a score to track while tuning
  prompts.
- **What:** reuse the `Embedder` from `packages/ingestion` (`EMBEDDING_URL`, `EMBEDDING_MODEL`).
  Embed each golden fact and the agent's answer text (the `answer` field, not the sources). Score
  fact coverage: for each golden fact, the best cosine similarity against the answer's sentences.
  Golden vectors go in a cache keyed by the embedder's fingerprint and the text hash, so a change to
  the model or the text re-embeds them. The cache is not committed: vectors are noisy in git, and
  seven cases embed in about a second.
- **Calibration:** add known-wrong answers to the golden set as negative examples, and pick a
  threshold per case from the gap between right and wrong scores.
- **Cost:** the evals then also need a running embedding server.
- **Done when:** the score appears in the run output next to the deterministic verdict, with tests on
  the similarity maths and the cache key, and no scenario gates on it yet.

### 7. Results history and comparison

- **Why:** tuning a prompt needs "did the pass rate move", not one run.
- **What:** each run writes a JSON result (scenario, pass rate, per-layer scores, model, date) under
  an ignored `evals/out/` folder; a small command compares two result files.
- **Done when:** a comparison of two sample files prints the changes per scenario.

### 8. Optional: tool-sequence distance as a reported number

- Edit distance between the expected and the actual tool-name sequence, shown in the report only. The
  agent's real paths vary, and `toolsInclude` and `toolsExclude` already express what matters, so
  this is never a gate.

## Rejected for now

- **Levenshtein on whole answers:** meaningless for long Markdown against a one-sentence fact.
- **Qdrant for the golden vectors:** overkill until the golden set holds hundreds of cases.
- **Promptfoo:** dropped when the scenarios became `bun:test` files; the comparison it offered is
  item 7.

## Open decisions

1. Which provider and model grades the judge (item 5).
2. What to do about the orchestrator scenario and its model (item 4).
3. Whether similarity ever becomes a gate, and on which cases (item 6).
4. How the judge reaches a model (item 5).

## Risks

- A judge or an embedding threshold that is not calibrated produces confident wrong verdicts. Both
  start as reported scores.
- Volatile golden cases (a home, the news) go stale; `reviewBy` dates and the warning in item 1 are the
  only guard.
- Every layer added makes a run slower and adds a service the evals depend on. Layers 2 and 3 should
  be switchable off, so a plain run still needs only the stack.
