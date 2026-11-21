import { Elysia, t } from "elysia";

import { doc, errors } from "../../../http/openapi";
import { tasksGuard } from "../tasks-guard";
import type { TasksService } from "../tasks-service";
import { DocumentsModel, MAX_UPLOAD_BYTES } from "./documents-model";
import type { DocumentsService } from "./documents-service";

const tag = "Documents";
const notSupported = {
  ...errors.notSupported,
  description: "The extract service is not configured (`not_supported`).",
};

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
    .get("", async ({ task }) => ({ documents: await documentsService!.list(task.taskId) }), {
      params: DocumentsModel.taskParams,
      ...doc(tag, "List the documents attached to a task", {
        200: {
          description: "The documents.",
          schema: t.Object({ documents: t.Array(DocumentsModel.summary) }),
        },
        400: errors.invalid,
        404: errors.taskNotFound,
        501: notSupported,
        502: errors.dependency,
      }),
    })
    .post(
      "",
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
        ...doc(tag, "Attach a document: upload a file, which the extract service turns into text", {
          201: {
            description:
              "The document (identified by its SHA-256 checksum; the same file is stored once).",
            schema: DocumentsModel.summary,
          },
          400: "The multipart field `file` is required (`file_required`).",
          404: errors.taskNotFound,
          413: "The upload is over 25 MiB (`file_too_large`), or its text is too large to store (`document_too_large`).",
          422: "The file could not be turned into text (`extraction_failed`).",
          501: notSupported,
          502: errors.dependency,
        }),
      },
    )
    .get(
      "/:documentId",
      async ({ task, params, status }) =>
        (await documentsService!.get(task.taskId, params.documentId)) ??
        status(404, { error: "document_not_found" }),
      {
        params: DocumentsModel.params,
        ...doc(tag, "Get a document with its text", {
          200: {
            description: "The document and its extracted `content`.",
            schema: t.Object({
              documentId: t.String(),
              filename: t.String(),
              checksum: t.String(),
              contentType: t.String(),
              content: t.String(),
            }),
          },
          400: errors.invalid,
          404: "No such task or document (`task_not_found`, `document_not_found`).",
          501: notSupported,
          502: errors.dependency,
        }),
      },
    )
    .delete(
      "/:documentId",
      async ({ task, params, status }) =>
        (await documentsService!.delete(task.taskId, params.documentId))
          ? status(204, undefined)
          : status(404, { error: "document_not_found" }),
      {
        params: DocumentsModel.params,
        ...doc(tag, "Detach a document from a task", {
          204: "Detached; the document is deleted when no task uses it.",
          400: errors.invalid,
          404: "No such task or document (`task_not_found`, `document_not_found`).",
          501: notSupported,
          502: errors.dependency,
        }),
      },
    );
