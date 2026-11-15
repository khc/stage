import { Elysia } from "elysia";

import { documentsController } from "./documents/documents-controller";
import type { DocumentsService } from "./documents/documents-service";
import { sessionsController } from "./sessions/sessions-controller";
import type { SessionsService } from "./sessions/sessions-service";
import { TasksModel } from "./tasks-model";
import type { TasksService } from "./tasks-service";

export type TasksControllerDeps = {
  tasksService: TasksService;
  sessionsService: SessionsService;
  documentsService?: DocumentsService;
};

// Mounted at /tasks, with the sessions of a task under it. Task ids are matched
// case-insensitively and stored lowercase.
export const tasksController = ({
  tasksService,
  sessionsService,
  documentsService,
}: TasksControllerDeps) =>
  new Elysia({ prefix: "/tasks" })
    .post(
      "/",
      async ({ body, status }) => {
        const result = await tasksService.create({ ...body, prompt: body.prompt.trim() });
        if (result.status === "unknown_agent") return status(400, { error: "unknown_agent" });
        return status(201, result.task);
      },
      { body: TasksModel.createBody },
    )
    .get("/", async () => ({ tasks: await tasksService.list() }))
    .get(
      "/:taskId",
      async ({ params, status }) =>
        (await tasksService.get(params.taskId.toLowerCase())) ??
        status(404, { error: "task_not_found" }),
      { params: TasksModel.params },
    )
    .delete(
      "/:taskId",
      async ({ params, status }) =>
        (await tasksService.delete(params.taskId.toLowerCase())) === "deleted"
          ? status(204, undefined)
          : status(404, { error: "task_not_found" }),
      { params: TasksModel.params },
    )
    .use(sessionsController({ tasksService, sessionsService }))
    .use(documentsController({ tasksService, documentsService }));
