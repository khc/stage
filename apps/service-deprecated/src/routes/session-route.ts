import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { guard } from "../errors";
import { sessionParamSchema, taskParamSchema } from "../schemas";
import type { SessionService } from "../services/session-service";
import type { SessionStore } from "../stores/session-store";
import type { TaskStore } from "../stores/task-store";
import { sessionStats } from "../utils/session-stats";
import { KEEPALIVE_MS, sseResponse } from "./shared";

// Mounted under /tasks: the sessions of a task, their stats and the live message stream.
export const sessionRoute = (
  tasks: Pick<TaskStore, "get">,
  sessions: SessionStore,
  service: SessionService,
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
        const controller = new AbortController();
        const result = await service.messages(taskId, sessionId, {
          signal: controller.signal,
          idleMs: KEEPALIVE_MS,
        });
        if (result.status !== "ok") return c.json({ error: result.status }, 404);
        return sseResponse(c, controller, result.entries);
      },
    );
