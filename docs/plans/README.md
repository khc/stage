# Plans and reviews

Design notes, proposals and reviews kept for context. They are **not** documentation of how the system works today: for that, start at the [docs index](../../README.md#documentation).

| File                                                                                                 | What it is                                                                                | Status                                                     |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [review.md](review.md)                                                                               | Architecture and security review of the Hono service that `apps/control-service` replaced | Historical; links to `apps/service-hono` are dead          |
| [platform-evolution.md](platform-evolution.md)                                                       | Ideas for the platform: eval harness, guardrails, approvals, memory, MCP                  | Proposals                                                  |
| [scheduler-plan.md](scheduler-plan.md)                                                               | Per-task run schedules through Cloud Scheduler                                            | Proposal (config exists, routes are not built)             |
| [scheduler-tasks.md](scheduler-tasks.md)                                                             | Work breakdown of the scheduler plan                                                      | In progress                                                |
| [evals-improvement-plan.md](evals-improvement-plan.md)                                               | Roadmap for the agent evals                                                               | Draft                                                      |
| [superpowers/specs/2026-11-22-api-evals-design.md](superpowers/specs/2026-11-22-api-evals-design.md) | Design of the API-driven evals in `evals/`                                                | Implemented (see [evals/README.md](../../evals/README.md)) |
