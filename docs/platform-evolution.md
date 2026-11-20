# Platform evolution

Ideas for what to add to the platform, ranked by how well they fit the gaps found while building the `discovery-assistant` web search (November 2026). Status: proposals, none planned or started except where noted.

The web research behind this was mostly Python ADK documentation. Check each item against the ADK JS docs before planning it; the open questions are listed per item.

## 1. Agent evaluation harness

**Why.** The failures we hit were routing and behaviour regressions: the agent searched the web before querying IMDb, a guard blocked an IMDb-then-web follow-up, and a missing key surfaced as `web_search_not_configured`. Unit tests with a scripted model do not catch these. Today only `bun run --filter @stage/knowledge-agents smoke` exercises an agent live.

**What.**
- Keep eval sets of expected tool-call sequences and final answers per agent. ADK's [evaluation framework](https://adk.dev/evaluate/) scores trajectories and tool use. Eval sets and criteria are separate, so one recorded interaction can be scored in different ways.
- The first cases already exist as sessions: "what is the cast of Friends?" (internal discovery, then IMDb), then "where is she living?" (web, with a model-written query).
- MLflow is already in the observability plane, and [`mlflow.genai.evaluate`](https://mlflow.org/docs/3.5.0/genai/eval-monitor) adds scorers and LLM judges.

**Open.** The sources do not show ADK traces or eval sets feeding MLflow directly. Does ADK JS ship the eval runner?

**Effort.** Medium. This should come first: items 2 and 3 need it to be safe to change.

## 2. Reusable guardrails layer in `packages/agents`

**Why.** The Exa guard lives inside one agent (`discovery-agent.ts`) and reviews found gaps: parallel `search_web` calls bypass the per-turn cap, and the guard is scoped to one turn.

**What.**
- Follow ADK's [layered safety guidance](https://adk.dev/safety/): input and response validation, and deterministic tool-context policies that the model cannot set (tool arguments come from the model, tool context from the developer).
- Register policies as a plugin on the Runner so they apply to every agent, instead of per-agent callbacks.
- On GCP, put [Model Armor](https://cloud.google.com/blog/topics/developers-practitioners/agent-factory-recap-securing-ai-agents-in-production) in front of the model to screen prompt injection and sensitive data.

**Open.** Plugin support and Model Armor integration in ADK JS. A judge model can itself be injected, so keep deterministic checks for anything that moves data out.

**Effort.** Medium.

## 3. Human approval for sensitive tool calls

**Why.** It would settle the guard trade-off. When internal data is in context, show the user the proposed web query and let them approve it, instead of choosing between blocking it and trusting it.

**What.** The runtime already resumes sessions through queued messages, so an "approval requested" event plus a UI button fits the existing flow. ADK's tool confirmation is described as experimental.

**Open.** A [write-up](https://neuraltrust.ai/blog/google-adk-security) reports that before ADK Python 2.5.0 an attacker could forge confirmations. This repo is on `^2.5.0`, but the JS equivalent was not checked.

**Effort.** Medium to large (runtime, service and UI).

## 4. Long-term memory and context compaction

**Why.** Sessions and events accumulate in Firestore and in the model's context, and nothing carries across sessions.

**What.** ADK separates session history from long-term memory. [Memory Bank](https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview) is the managed option on GCP, written to explicitly from a finished session. Context compaction (summarising old turns) would bound context growth.

**Open.** Compaction was described only by a third-party blog, so confirm the config names in the ADK JS docs. Memory Bank has no Floci equivalent.

**Effort.** Medium.

## 5. MCP tools and A2A exposure

**Why.** The service already serves agent cards at `/jobs/:job/agents/:a/card`. ADK frames [MCP as agent-to-tool and A2A as agent-to-agent](https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/). Wrapping agents as A2A services, or consuming external MCP servers, would extend `packages/tools` without bespoke tools.

**Open.** MCP support is listed for [ADK JS](https://docsearch.algolia.com/mcp/docs/repo/google/adk-js). No TypeScript A2A or agent-card documentation was found.

**Effort.** Small to medium, after the open question is answered.

## 6. Smaller items

- **Usage and cost view.** Token usage is already stored per session. Add a per-task budget and a cap on Exa calls, which would also close the parallel-call gap from item 2.
- **Trace links.** Link each run in the UI to its MLflow trace.
- **Secrets on GCP.** Move `EXA_API_KEY` and the other keys to Secret Manager in `infra/envs/gcp`. Locally they are plain job environment values in Terraform state.
- **Task schedules.** Already proposed in [scheduler-plan.md](scheduler-plan.md).

## Sources

- [ADK evaluation](https://adk.dev/evaluate/)
- [MLflow evaluation docs](https://mlflow.org/docs/3.5.0/genai/eval-monitor)
- [ADK safety](https://adk.dev/safety/)
- [Agent Factory: securing agents in production](https://cloud.google.com/blog/topics/developers-practitioners/agent-factory-recap-securing-ai-agents-in-production)
- [NeuralTrust: Google ADK security](https://neuraltrust.ai/blog/google-adk-security)
- [Vertex AI Memory Bank overview](https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview)
- [Developer's Guide to AI Agent Protocols](https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/)
- [ADK JS (docsearch)](https://docsearch.algolia.com/mcp/docs/repo/google/adk-js)
