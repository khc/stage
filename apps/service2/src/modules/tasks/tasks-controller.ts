import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Elysia } from "elysia";

import { documentsController } from "./documents/documents-controller";
import type { DocumentsService } from "./documents/documents-service";
import { sessionsController } from "./sessions/sessions-controller";
import type { SessionsService } from "./sessions/sessions-service";
import { TasksModel } from "./tasks-model";
import type { Resume, TasksService } from "./tasks-service";

const isResume = TypeCompiler.Compile(TasksModel.resume);

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
    .post(
      "/:taskId/run",
      async ({ params, request, status }) => {
        const raw = (await request.json().catch(() => undefined)) as
          | Record<string, unknown>
          | undefined;
        let resume: Resume | undefined;
        if (raw?.sessionId !== undefined) {
          if (!isResume.Check(raw)) return status(400, { success: false, error: "invalid_resume" });
          resume = { sessionId: raw.sessionId, message: raw.message.trim() };
        }
        const result = await tasksService.run(params.taskId.toLowerCase(), resume);
        switch (result.status) {
          case "started":
            return status(202, { operation: result.operation });
          case "task_not_found":
          case "session_not_found":
            return status(404, { error: result.status });
          default:
            return status(409, { error: result.status });
        }
      },
      {
        params: TasksModel.params,
        // Elysia would answer 400 to a body that is not JSON; here it is a plain run, as in
        // apps/service, so the handler reads the body itself.
        parse: "none",
      },
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
