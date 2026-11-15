import { Elysia } from "elysia";

import { KEEPALIVE_MS, toSse } from "../../../utils/sse";
import { tasksGuard } from "../tasks-guard";
import type { TasksService } from "../tasks-service";
import { SessionsModel } from "./sessions-model";
import type { SessionsService } from "./sessions-service";

export type SessionsControllerDeps = {
  tasksService: Pick<TasksService, "get">;
  sessionsService: SessionsService;
};

// Mounted under /tasks: the sessions of a task. tasksGuard has already checked the task exists.
export const sessionsController = ({ tasksService, sessionsService }: SessionsControllerDeps) =>
  new Elysia({ prefix: "/:taskId/sessions" })
    .use(tasksGuard(tasksService))
    .get("/", async ({ task }) => ({ sessions: await sessionsService.list(task.taskId) }), {
      params: SessionsModel.taskParams,
    })
    .get(
      "/:sessionId",
      async ({ task, params, status }) =>
        (await sessionsService.get(task.taskId, params.sessionId)) ??
        status(404, { error: "session_not_found" }),
      { params: SessionsModel.params },
    )
    .get(
      "/:sessionId/stats",
      async ({ task, params, status }) =>
        (await sessionsService.stats(task.taskId, params.sessionId)) ??
        status(404, { error: "session_not_found" }),
      { params: SessionsModel.params },
    )
    .get(
      "/:sessionId/messages",
      async function* ({ task, params, request, status }) {
        const controller = new AbortController();
        // A disconnect aborts the feed at once, which also unsubscribes from Pub/Sub.
        request.signal.addEventListener("abort", () => controller.abort(), { once: true });
        const result = await sessionsService.messages(task.taskId, params.sessionId, {
          signal: controller.signal,
          idleMs: KEEPALIVE_MS,
        });
        if (result.status !== "ok") return status(404, { error: result.status });
        try {
          for await (const entry of result.entries) yield toSse(entry);
        } finally {
          controller.abort();
        }
      },
      { params: SessionsModel.params },
    )
    .delete(
      "/:sessionId",
      async ({ task, params, status }) =>
        (await sessionsService.delete(task.taskId, params.sessionId))
          ? status(204, undefined)
          : status(404, { error: "session_not_found" }),
      { params: SessionsModel.params },
    );
