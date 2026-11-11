import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { Scalar } from "@scalar/hono-api-reference";
import { openApiDocument } from "./openapi";
import {
  jobNameSchema,
  resumeSchema,
  taskSchema,
  taskParamSchema,
  sessionParamSchema,
} from "./schemas";
import type { ListJobs, Resume, RunJob } from "./jobs";
import type { CreateTask, ListTasks, GetTask } from "./tasks";
import type { TaskSessions } from "./sessions";
import type { LiveEvents } from "./live-events";
import { sessionStats } from "./stats";

const KEEPALIVE_MS = 5_000;

export const createApp = (
  runJob: RunJob,
  listJobs: ListJobs,
  createTask: CreateTask,
  listTasks: ListTasks,
  getTask: GetTask,
  sessions: TaskSessions,
  liveEvents?: LiveEvents,
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
    .get(
      "/tasks/:taskId/sessions/:sessionId/stats",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId)))
            return c.json({ error: "task_not_found" }, 404);
          const session = await sessions.get(taskId, sessionId);
          if (!session) return c.json({ error: "session_not_found" }, 404);
          return c.json(sessionStats(session));
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "session_error" }, 502),
          });
        }
      },
    )
    .delete(
      "/tasks/:taskId/sessions/:sessionId",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId)))
            return c.json({ error: "task_not_found" }, 404);
          if (!(await sessions.delete(taskId, sessionId)))
            return c.json({ error: "session_not_found" }, 404);
          return c.body(null, 204);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "session_error" }, 502),
          });
        }
      },
    )
    .get(
      "/tasks/:taskId/sessions/:sessionId/messages",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        const pending: [string, string][] = [];
        let wake = () => {};
        let unsubscribe = () => {};
        let session: Awaited<ReturnType<TaskSessions["get"]>>;
        try {
          if (!(await getTask(taskId)))
            return c.json({ error: "task_not_found" }, 404);
          // Subscribe before reading history so no event falls in the gap.
          unsubscribe =
            (await liveEvents?.(taskId, sessionId, (id, json) => {
              pending.push([id, json]);
              wake();
            })) ?? unsubscribe;
          session = await sessions.get(taskId, sessionId);
        } catch (err) {
          unsubscribe();
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "events_error" }, 502),
          });
        }
        if (!session) {
          unsubscribe();
          return c.json({ error: "session_not_found" }, 404);
        }
        const history = session.events;
        return streamSSE(c, async (stream) => {
          const seen = new Set<string>();
          const send = async (id: string, data: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            await stream.writeSSE({ id, data });
          };
          stream.onAbort(unsubscribe);
          try {
            for (const event of history)
              await send(event.id, JSON.stringify(event));
            while (!stream.aborted) {
              for (const [id, json] of pending.splice(0)) await send(id, json);
              if (pending.length) continue;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, KEEPALIVE_MS);
                wake = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
              if (!pending.length) await stream.write(": keepalive\n\n");
            }
          } finally {
            unsubscribe();
          }
        });
      },
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
        const body = await c.req.json().catch(() => undefined);
        let resume: Resume | undefined;
        if (body?.sessionId !== undefined) {
          const parsed = resumeSchema.safeParse(body);
          if (!parsed.success)
            return c.json({ success: false, error: parsed.error }, 400);
          resume = parsed.data;
          try {
            if (!(await sessions.get(taskId, resume.sessionId)))
              return c.json({ error: "session_not_found" }, 404);
          } catch (err) {
            console.error(err);
            throw new HTTPException(502, {
              res: c.json({ error: "session_error" }, 502),
            });
          }
        }
        try {
          const operation = resume
            ? await runJob(jobName.data, taskId, resume)
            : await runJob(jobName.data, taskId);
          return c.json({ operation }, 202);
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
