import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Scalar } from "@scalar/hono-api-reference";
import { openApiDocument } from "./openapi";
import {
  chatSchema,
  jobNameSchema,
  taskSchema,
  taskParamSchema,
  sessionParamSchema,
} from "./schemas";
import type { RunAgent } from "../agent";
import type { ListJobs, RunJob } from "./jobs";
import type { CreateTask, ListTasks, GetTask } from "./tasks";
import type { TaskSessions } from "./sessions";

export const createApp = (
  run: RunAgent,
  runJob: RunJob,
  listJobs: ListJobs,
  createTask: CreateTask,
  listTasks: ListTasks,
  getTask: GetTask,
  sessions: TaskSessions,
) =>
  new Hono()
    .get("/openapi.json", (c) => c.json(openApiDocument))
    .get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Agent Jobs API" }))
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
    .post("/tasks", zValidator("json", taskSchema), async (c) => {
      try {
        return c.json(await createTask(c.req.valid("json")), 201);
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "task_error" }, 502),
        });
      }
    })
    .get("/tasks", async (c) => {
      try {
        return c.json({ tasks: await listTasks() });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "task_error" }, 502),
        });
      }
    })
    .get("/tasks/:taskId", zValidator("param", taskParamSchema), async (c) => {
      try {
        const contract = await getTask(c.req.valid("param").taskId);
        if (!contract) return c.json({ error: "task_not_found" }, 404);
        return c.json(contract);
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "task_error" }, 502),
        });
      }
    })
    .get(
      "/tasks/:taskId/sessions",
      zValidator("param", taskParamSchema),
      async (c) => {
        const { taskId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId)))
            return c.json({ error: "task_not_found" }, 404);
          return c.json({ sessions: await sessions.list(taskId) });
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "session_error" }, 502),
          });
        }
      },
    )
    .get(
      "/tasks/:taskId/sessions/:sessionId",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId)))
            return c.json({ error: "task_not_found" }, 404);
          const session = await sessions.get(taskId, sessionId);
          if (!session) return c.json({ error: "session_not_found" }, 404);
          return c.json(session);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "session_error" }, 502),
          });
        }
      },
    )
    .post("/chat", zValidator("json", chatSchema), async (c) =>
      c.json({ reply: await run(c.req.valid("json").message) }),
    )
    .post(
      "/tasks/:taskId/run",
      zValidator("param", taskParamSchema),
      async (c) => {
        const { taskId } = c.req.valid("param");
        let contract: Awaited<ReturnType<GetTask>>;
        try {
          contract = await getTask(taskId);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "task_error" }, 502),
          });
        }
        if (!contract) return c.json({ error: "task_not_found" }, 404);
        const jobName = jobNameSchema.safeParse(contract.jobName);
        if (!jobName.success)
          return c.json({ error: "task_not_executable" }, 409);
        try {
          return c.json({ operation: await runJob(jobName.data, taskId) }, 202);
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
