import { Elysia, t } from "elysia";

import { doc, errors } from "../../../http/openapi";
import { KEEPALIVE_MS, toSse } from "../../../utils/sse";
import { tasksGuard } from "../tasks-guard";
import type { TasksService } from "../tasks-service";
import { SessionsModel } from "./sessions-model";
import type { SessionsService } from "./sessions-service";

const tag = "Sessions";

export type SessionsControllerDeps = {
  tasksService: Pick<TasksService, "get">;
  sessionsService: SessionsService;
};

// Mounted under /tasks: the sessions of a task. tasksGuard has already checked the task exists.
export const sessionsController = ({ tasksService, sessionsService }: SessionsControllerDeps) =>
  new Elysia({ prefix: "/:taskId/sessions" })
    .use(tasksGuard(tasksService))
    .get("", async ({ task }) => ({ sessions: await sessionsService.list(task.taskId) }), {
      params: SessionsModel.taskParams,
      ...doc(tag, "List the sessions of a task", {
        200: {
          description: "The sessions.",
          schema: t.Object({ sessions: t.Array(SessionsModel.summary) }),
        },
        400: errors.invalid,
        404: errors.taskNotFound,
        502: errors.dependency,
      }),
    })
    .get(
      "/:sessionId",
      async ({ task, params, status }) =>
        (await sessionsService.get(task.taskId, params.sessionId)) ??
        status(404, { error: "session_not_found" }),
      {
        params: SessionsModel.params,
        ...doc(tag, "Get a session with its state and events", {
          200: {
            description: "The session: its summary plus `state` and the ordered `events`.",
            schema: t.Object({}, { additionalProperties: true }),
          },
          400: errors.invalid,
          404: "No such task or session (`task_not_found`, `session_not_found`).",
          502: errors.dependency,
        }),
      },
    )
    .get(
      "/:sessionId/stats",
      async ({ task, params, status }) =>
        (await sessionsService.stats(task.taskId, params.sessionId)) ??
        status(404, { error: "session_not_found" }),
      {
        params: SessionsModel.params,
        ...doc(tag, "Get the model usage of a session", {
          200: { description: "Event, model call and token totals.", schema: SessionsModel.stats },
          400: errors.invalid,
          404: "No such task or session (`task_not_found`, `session_not_found`).",
          502: errors.dependency,
        }),
      },
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
      {
        params: SessionsModel.params,
        ...doc(tag, "Stream the events of a session", {
          200: {
            description:
              "Server-Sent Events: the stored events first, then live ones, each with its id; a `keepalive` event every 5 seconds when idle.",
            schema: t.String(),
            contentType: "text/event-stream",
          },
          400: errors.invalid,
          404: "No such task or session (`task_not_found`, `session_not_found`).",
          502: errors.dependency,
        }),
      },
    )
    .delete(
      "/:sessionId",
      async ({ task, params, status }) =>
        (await sessionsService.delete(task.taskId, params.sessionId))
          ? status(204, undefined)
          : status(404, { error: "session_not_found" }),
      {
        params: SessionsModel.params,
        ...doc(tag, "Delete a session", {
          204: "Deleted.",
          400: errors.invalid,
          404: "No such task or session (`task_not_found`, `session_not_found`).",
          502: errors.dependency,
        }),
      },
    );
