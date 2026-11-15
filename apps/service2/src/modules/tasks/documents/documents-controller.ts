import { Elysia } from "elysia";

import { tasksGuard } from "../tasks-guard";
import type { TasksService } from "../tasks-service";
import { DocumentsModel, MAX_UPLOAD_BYTES } from "./documents-model";
import type { DocumentsService } from "./documents-service";

export type DocumentsControllerDeps = {
  tasksService: Pick<TasksService, "get">;
  // Undefined when the extract service is not configured: every route answers 501.
  documentsService?: DocumentsService;
};

// Mounted under /tasks: the documents attached to a task. The 501 check comes before
// the task guard, so an unconfigured service answers 501 even for an unknown task.
export const documentsController = ({ tasksService, documentsService }: DocumentsControllerDeps) =>
  new Elysia({ prefix: "/:taskId/documents" })
    .onBeforeHandle(({ status }) => {
      if (!documentsService) return status(501, { error: "not_supported" });
    })
    .use(tasksGuard(tasksService))
    .get("/", async ({ task }) => ({ documents: await documentsService!.list(task.taskId) }), {
      params: DocumentsModel.taskParams,
    })
    .post(
      "/",
      async ({ task, body, status }) => {
        const file = (body as { file?: unknown } | undefined)?.file;
        if (!(file instanceof File)) return status(400, { error: "file_required" });
        const result = await documentsService!.create(task.taskId, file);
        if (result.status === "created") return status(201, result.document);
        return status(result.status === "document_too_large" ? 413 : 422, {
          error: result.status,
        });
      },
      {
        params: DocumentsModel.taskParams,
        beforeHandle: ({ request, status }) => {
          if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES)
            return status(413, { error: "file_too_large" });
        },
      },
    )
    .get(
      "/:documentId",
      async ({ task, params, status }) =>
        (await documentsService!.get(task.taskId, params.documentId)) ??
        status(404, { error: "document_not_found" }),
      { params: DocumentsModel.params },
    )
    .delete(
      "/:documentId",
      async ({ task, params, status }) =>
        (await documentsService!.delete(task.taskId, params.documentId))
          ? status(204, undefined)
          : status(404, { error: "document_not_found" }),
      { params: DocumentsModel.params },
    );
