import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { DependencyError, guard } from "../errors";
import type { LiveEvents } from "../platform/live-events";
import { sessionParamSchema, taskParamSchema } from "../schemas";
import { sessionStats } from "../stats";
import type { SessionStore } from "../stores/session-store";
import type { TaskStore } from "../stores/task-store";
import { KEEPALIVE_MS, noop } from "./shared";

// Mounted under /tasks: the sessions of a task, their stats and the live message stream.
export const sessionRoute = (
  tasks: Pick<TaskStore, "get">,
  sessions: SessionStore,
  liveEvents?: LiveEvents,
) =>
  new Hono()
    .get("/:taskId/sessions", zValidator("param", taskParamSchema), async (c) => {
      const { taskId } = c.req.valid("param");
      return guard("session_error", async () => {
        if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
        return c.json({ sessions: await sessions.list(taskId) });
      });
    })
    .get("/:taskId/sessions/:sessionId", zValidator("param", sessionParamSchema), async (c) => {
      const { taskId, sessionId } = c.req.valid("param");
      return guard("session_error", async () => {
        if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
        const session = await sessions.get(taskId, sessionId);
        if (!session) return c.json({ error: "session_not_found" }, 404);
        return c.json(session);
      });
    })
    .get(
      "/:taskId/sessions/:sessionId/stats",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        return guard("session_error", async () => {
          if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
          const session = await sessions.get(taskId, sessionId);
          if (!session) return c.json({ error: "session_not_found" }, 404);
          return c.json(sessionStats(session));
        });
      },
    )
    .delete("/:taskId/sessions/:sessionId", zValidator("param", sessionParamSchema), async (c) => {
      const { taskId, sessionId } = c.req.valid("param");
      return guard("session_error", async () => {
        if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
        if (!(await sessions.delete(taskId, sessionId)))
          return c.json({ error: "session_not_found" }, 404);
        return c.body(null, 204);
      });
    })
    .get(
      "/:taskId/sessions/:sessionId/messages",
      zValidator("param", sessionParamSchema),
      async (c) => {
        const { taskId, sessionId } = c.req.valid("param");
        const pending: [string, string][] = [];
        let wake = noop;
        let unsubscribe = noop;
        let session: Awaited<ReturnType<SessionStore["get"]>>;
        try {
          if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
          // Subscribe before reading history so no event falls in the gap.
          unsubscribe =
            (await liveEvents?.(taskId, sessionId, (id, json) => {
              pending.push([id, json]);
              wake();
            })) ?? unsubscribe;
          session = await sessions.get(taskId, sessionId);
        } catch (err) {
          unsubscribe();
          throw new DependencyError("events_error", err);
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
    );
