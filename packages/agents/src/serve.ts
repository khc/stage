import { flushTelemetry, traceJob } from "@stage/http/otel";
import { z } from "zod";

import { RunInProgressError } from "./session-service";

export type RunTaskInput = { taskId: string; sessionId?: string };
// Runs one task and returns the agent's reply; the signal stops the run when its budget is spent.
export type RunTask = (input: RunTaskInput, signal?: AbortSignal) => Promise<string>;

// The longest budget a run gets: a caller asks for less with `budgetMs`, and one that asks for more or
// for none gets this one.
export const MAX_BUDGET_MS = 10 * 60_000;

const bodySchema = z.object({
  taskId: z.uuid(),
  // The limit matches the one the service puts on a session id in a request.
  sessionId: z.string().min(1).max(1500).optional(),
  budgetMs: z.int().positive().optional(),
});

const json = (body: unknown, status: number) => Response.json(body, { status });

// The HTTP host of the run path a job runs: `POST /run` runs a task and answers with the reply.
// A run already in progress is a 409, a run stopped by its `budgetMs` a 504, any other failure a 500.
export const createServeHandler =
  (runTask: RunTask) =>
  async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/health") return new Response("ok");
    if (req.method !== "POST" || pathname !== "/run") return json({ error: "not_found" }, 404);

    const body = bodySchema.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return json({ error: "invalid_body" }, 400);
    const { sessionId, budgetMs } = body.data;
    const taskId = body.data.taskId.toLowerCase();
    const budget = AbortSignal.timeout(Math.min(budgetMs ?? MAX_BUDGET_MS, MAX_BUDGET_MS));
    // A caller that disconnects stops the run too.
    const signal = AbortSignal.any([req.signal, budget]);

    const outcome: { reply?: string; error?: unknown } = {};
    await traceJob("agent_job", async () => {
      try {
        outcome.reply = await runTask({ taskId, ...(sessionId && { sessionId }) }, signal);
        return 0;
      } catch (err) {
        outcome.error = err;
        return 1;
      }
    });
    await flushTelemetry();

    if (outcome.reply !== undefined) return json({ reply: outcome.reply }, 200);
    if (outcome.error instanceof RunInProgressError) return json({ error: "run_in_progress" }, 409);
    if (budget.aborted) return json({ error: "quick_timeout" }, 504);
    console.error(outcome.error);
    return json({ error: "run_failed" }, 500);
  };
