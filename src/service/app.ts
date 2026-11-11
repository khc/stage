import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { RunAgent } from "../agent";
import type { ListJobs, RunJob } from "./jobs";

const MAX_MESSAGE_LENGTH = 10_000;
const message = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

const chatSchema = z.object({ message });
const jobParamSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z]([-a-z0-9]*[a-z0-9])?$/)
    .max(63),
});
const jobRunSchema = z.object({ message: message.optional() });

export const createApp = (run: RunAgent, runJob: RunJob, listJobs: ListJobs) =>
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
    .post("/chat", zValidator("json", chatSchema), async (c) =>
      c.json({ reply: await run(c.req.valid("json").message) }),
    )
    .post(
      "/jobs/:name/run",
      zValidator("param", jobParamSchema),
      zValidator("json", jobRunSchema),
      async (c) => {
        try {
          const { name } = c.req.valid("param");
          const { message } = c.req.valid("json");
          return c.json({ operation: await runJob(name, message) }, 202);
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
