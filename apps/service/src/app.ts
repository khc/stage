import type { ListAgents } from "@stage/agents/agent-registry";
import { zValidator } from "@hono/zod-validator";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";

import { DocumentTooLargeError, ExtractionError, type TaskDocuments } from "./documents";
import type { ListJobs, RegisterJob, Resume, RunJob } from "./jobs";
import type { LiveEvents } from "./live-events";
import type { PlatformStream } from "./platform-stream";
import { openApiDocument } from "./openapi";
import {
  jobNameSchema,
  documentParamSchema,
  jobParamSchema,
  resumeSchema,
  taskSchema,
  taskParamSchema,
  sessionParamSchema,
} from "./schemas";
import type { TaskSessions } from "./sessions";
import { sessionStats } from "./stats";
import type { CreateTask, DeleteTask, ListTasks, GetTask } from "./tasks";

const KEEPALIVE_MS = 5_000;
const SEEN_LIMIT = 1_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const noop = () => {};

export type AgentRegistry = { register: RegisterJob; list: ListAgents };

export const createApp = (
  runJob: RunJob,
  listJobs: ListJobs,
  createTask: CreateTask,
  listTasks: ListTasks,
  getTask: GetTask,
  sessions: TaskSessions,
  liveEvents?: LiveEvents,
  registry?: AgentRegistry,
  deleteTask?: DeleteTask,
  documents?: TaskDocuments,
  platformStream?: PlatformStream,
) =>
  new Hono()
    .get("/openapi.json", (c) => c.json(openApiDocument))
    .get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Agent Jobs API" }))
    .get("/health", (c) => c.json({ status: "ok" }))
    .get("/events", async (c) => {
      if (!platformStream) return c.json({ error: "not_supported" }, 501);
      const pending: [string, string][] = [];
      let wake = noop;
      let unsubscribe = noop;
      try {
        unsubscribe = await platformStream((id, json) => {
          pending.push([id, json]);
          wake();
        });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, { res: c.json({ error: "events_error" }, 502) });
      }
      return streamSSE(c, async (stream) => {
        const seen = new Set<string>();
        stream.onAbort(unsubscribe);
        try {
          while (!stream.aborted) {
            for (const [id, data] of pending.splice(0)) {
              if (seen.has(id)) continue;
              seen.add(id);
              if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
              await stream.writeSSE({ id, data });
            }
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
    })
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
    .get("/jobs/:jobName/agents", zValidator("param", jobParamSchema), async (c) => {
      try {
        const agents = (await registry?.list(c.req.valid("param").jobName)) ?? [];
        return c.json({ agents });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "agents_error" }, 502),
        });
      }
    })
    .post("/jobs/:jobName/register", zValidator("param", jobParamSchema), async (c) => {
      if (!registry) return c.json({ error: "not_supported" }, 501);
      try {
        const operation = await registry.register(c.req.valid("param").jobName);
        return c.json({ operation }, 202);
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "job_error" }, 502),
        });
      }
    })
    .post("/tasks", zValidator("json", taskSchema), async (c) => {
      const input = c.req.valid("json");
      try {
        // A job with registered agents only accepts those; a job without a
        // registration cannot be verified and keeps accepting any valid name.
        if (input.agentName !== undefined) {
          const known = (await registry?.list(input.jobName)) ?? [];
          if (known.length && !known.some((a) => a.name === input.agentName))
            return c.json({ error: "unknown_agent" }, 400);
        }
        return c.json(await createTask(input), 201);
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
    .delete("/tasks/:taskId", zValidator("param", taskParamSchema), async (c) => {
      if (!deleteTask) return c.json({ error: "not_supported" }, 501);
      const { taskId } = c.req.valid("param");
      try {
        const task = await getTask(taskId);
        if (!task) return c.json({ error: "task_not_found" }, 404);
        // Sessions go first, so a failure leaves the task in place to retry.
        for (const { id } of await sessions.list(taskId)) await sessions.delete(taskId, id);
        await deleteTask(taskId);
        // Documents no other task uses are removed; a failure here is only
        // logged, since the task is already gone.
        await documents
          ?.release((task.documents ?? []).map((d) => d.documentId))
          .catch((err) => console.error(err));
        return c.body(null, 204);
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "task_error" }, 502),
        });
      }
    })
    .get("/tasks/:taskId/documents", zValidator("param", taskParamSchema), async (c) => {
      if (!documents) return c.json({ error: "not_supported" }, 501);
      const { taskId } = c.req.valid("param");
      try {
        if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
        return c.json({ documents: await documents.list(taskId) });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "document_error" }, 502),
        });
      }
    })
    .post(
      "/tasks/:taskId/documents",
      bodyLimit({
        maxSize: MAX_UPLOAD_BYTES,
        onError: (c) => c.json({ error: "file_too_large" }, 413),
      }),
      zValidator("param", taskParamSchema),
      async (c) => {
        if (!documents) return c.json({ error: "not_supported" }, 501);
        const { taskId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
          const file = (await c.req.parseBody().catch(() => undefined))?.file;
          if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
          return c.json(await documents.add(taskId, file), 201);
        } catch (err) {
          if (err instanceof DocumentTooLargeError)
            return c.json({ error: "document_too_large" }, 413);
          if (err instanceof ExtractionError) return c.json({ error: "extraction_failed" }, 422);
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "document_error" }, 502),
          });
        }
      },
    )
    .get(
      "/tasks/:taskId/documents/:documentId",
      zValidator("param", documentParamSchema),
      async (c) => {
        if (!documents) return c.json({ error: "not_supported" }, 501);
        const { taskId, documentId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
          const document = await documents.get(taskId, documentId);
          if (!document) return c.json({ error: "document_not_found" }, 404);
          return c.json(document);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "document_error" }, 502),
          });
        }
      },
    )
    .delete(
      "/tasks/:taskId/documents/:documentId",
      zValidator("param", documentParamSchema),
      async (c) => {
        if (!documents) return c.json({ error: "not_supported" }, 501);
        const { taskId, documentId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
          if (!(await documents.remove(taskId, documentId)))
            return c.json({ error: "document_not_found" }, 404);
          return c.body(null, 204);
        } catch (err) {
          console.error(err);
          throw new HTTPException(502, {
            res: c.json({ error: "document_error" }, 502),
          });
        }
      },
    )
    .get("/tasks/:taskId/sessions", zValidator("param", taskParamSchema), async (c) => {
      const { taskId } = c.req.valid("param");
      try {
        if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
        return c.json({ sessions: await sessions.list(taskId) });
      } catch (err) {
        console.error(err);
        throw new HTTPException(502, {
          res: c.json({ error: "session_error" }, 502),
        });
      }
    })
    .get(
      "/tasks/:taskId/sessions/:sessionId",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        try {
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
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
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
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
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
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
        let wake = noop;
        let unsubscribe = noop;
        let session: Awaited<ReturnType<TaskSessions["get"]>>;
        try {
          if (!(await getTask(taskId))) return c.json({ error: "task_not_found" }, 404);
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
            for (const event of history) await send(event.id, JSON.stringify(event));
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
    .post("/tasks/:taskId/run", zValidator("param", taskParamSchema), async (c) => {
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
      if (!jobName.success) return c.json({ error: "task_not_executable" }, 409);
      const body = await c.req.json().catch(() => undefined);
      let resume: Resume | undefined;
      if (body?.sessionId !== undefined) {
        const parsed = resumeSchema.safeParse(body);
        if (!parsed.success) return c.json({ success: false, error: parsed.error }, 400);
        resume = parsed.data;
        try {
          const existing = await sessions.get(taskId, resume.sessionId);
          if (!existing) return c.json({ error: "session_not_found" }, 404);
          if (existing.run?.status === "running") return c.json({ error: "run_in_progress" }, 409);
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
    })
    .onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse();
      console.error(err);
      return c.json({ error: "agent_error" }, 502);
    });
