import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { RunAgent } from "../agent";
import type { RunJob } from "./jobs";

const chatSchema = z.object({ message: z.string().min(1) });
const jobParamSchema = z.object({
  name: z.string().regex(/^[a-z]([-a-z0-9]*[a-z0-9])?$/).max(63),
});

export const createApp = (run: RunAgent, runJob: RunJob) =>
  new Hono()
    .get("/health", (c) => c.json({ status: "ok" }))
    .post("/chat", zValidator("json", chatSchema), async (c) =>
      c.json({ reply: await run(c.req.valid("json").message) }),
    )
    .post("/jobs/:name/run", zValidator("param", jobParamSchema), async (c) => {
      try {
        return c.json({ operation: await runJob(c.req.valid("param").name) }, 202);
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "job_error" }, 502),
        });
      }
    })
    .onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse();
      console.error(err);
      return c.json({ error: "agent_error" }, 502);
    });
