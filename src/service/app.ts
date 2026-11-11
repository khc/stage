import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { RunAgent } from "../agent";
import type { ListJobs, RunJob } from "./jobs";
import type { CreateRun, ListRuns, GetRun } from "./runs";

const MAX_MESSAGE_LENGTH = 10_000;
const message = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

const chatSchema = z.object({ message });
const jobNameSchema = z
  .string()
  .regex(/^[a-z]([-a-z0-9]*[a-z0-9])?$/)
  .max(63);
const runSchema = z.object({ prompt: message, jobName: jobNameSchema });
const runParamSchema = z.object({
  runId: z.uuid().transform((id) => id.toLowerCase()),
});

export const createApp = (
  run: RunAgent,
  runJob: RunJob,
  listJobs: ListJobs,
  createRun: CreateRun,
  listRuns: ListRuns,
  getRun: GetRun,
) =>
  new Hono()
    .get("/health", (c) => c.json({ status: "ok" }))
    .get("/jobs", async (c) => {
      try {
        return c.json({ jobs: await listJobs() });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "job_error" }, 502),
        });
      }
    })
    .post("/jobs/runs", zValidator("json", runSchema), async (c) => {
      try {
        return c.json(await createRun(c.req.valid("json")), 201);
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "run_error" }, 502),
        });
      }
    })
    .get("/jobs/runs", async (c) => {
      try {
        return c.json({ runs: await listRuns() });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "run_error" }, 502),
        });
      }
    })
    .get(
      "/jobs/runs/:runId",
      zValidator("param", runParamSchema),
      async (c) => {
        try {
          const contract = await getRun(c.req.valid("param").runId);
          if (!contract) return c.json({ error: "run_not_found" }, 404);
          return c.json(contract);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "run_error" }, 502),
          });
        }
      },
    )
    .post("/chat", zValidator("json", chatSchema), async (c) =>
      c.json({ reply: await run(c.req.valid("json").message) }),
    )
    .post(
      "/jobs/runs/:runId/exec",
      zValidator("param", runParamSchema),
      async (c) => {
        const { runId } = c.req.valid("param");
        let contract: Awaited<ReturnType<GetRun>>;
        try {
          contract = await getRun(runId);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "run_error" }, 502),
          });
        }
        if (!contract) return c.json({ error: "run_not_found" }, 404);
        const jobName = jobNameSchema.safeParse(contract.jobName);
        if (!jobName.success)
          return c.json({ error: "run_not_executable" }, 409);
        try {
          return c.json({ operation: await runJob(jobName.data, runId) }, 202);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "job_error" }, 502),
          });
        }
      },
    )
    .onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse();
      console.error(err);
      return c.json({ error: "agent_error" }, 502);
    });
