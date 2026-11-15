import { Elysia } from "elysia";

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
    .delete(
      "/:sessionId",
      async ({ task, params, status }) =>
        (await sessionsService.delete(task.taskId, params.sessionId))
          ? status(204, undefined)
          : status(404, { error: "session_not_found" }),
      { params: SessionsModel.params },
    );
