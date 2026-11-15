import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { guard } from "../errors";
import { documentParamSchema, taskParamSchema } from "../schemas";
import {
  DocumentTooLargeError,
  ExtractionError,
  type DocumentStore,
} from "../stores/document-store";
import type { TaskStore } from "../stores/task-store";

const MAX_SERVICE_UPLOAD_BYTES = 25 * 1024 * 1024;

// Mounted under /tasks: the documents attached to a task.
export const documentRoute = (tasks: Pick<TaskStore, "get">, documents?: DocumentStore) =>
  new Hono()
    .get("/:taskId/documents", zValidator("param", taskParamSchema), async (c) => {
      if (!documents) return c.json({ error: "not_supported" }, 501);
      const { taskId } = c.req.valid("param");
      return guard("document_error", async () => {
        if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
        return c.json({ documents: await documents.list(taskId) });
      });
    })
    .post(
      "/:taskId/documents",
      bodyLimit({
        maxSize: MAX_SERVICE_UPLOAD_BYTES,
        onError: (c) => c.json({ error: "file_too_large" }, 413),
      }),
      zValidator("param", taskParamSchema),
      async (c) => {
        if (!documents) return c.json({ error: "not_supported" }, 501);
        const { taskId } = c.req.valid("param");
        return guard("document_error", async () => {
          if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
          const file = (await c.req.parseBody().catch(() => undefined))?.file;
          if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
          try {
            return c.json(await documents.create(taskId, file), 201);
          } catch (err) {
            if (err instanceof DocumentTooLargeError)
              return c.json({ error: "document_too_large" }, 413);
            if (err instanceof ExtractionError) return c.json({ error: "extraction_failed" }, 422);
            throw err;
          }
        });
      },
    )
    .get("/:taskId/documents/:documentId", zValidator("param", documentParamSchema), async (c) => {
      if (!documents) return c.json({ error: "not_supported" }, 501);
      const { taskId, documentId } = c.req.valid("param");
      return guard("document_error", async () => {
        if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
        const document = await documents.get(taskId, documentId);
        if (!document) return c.json({ error: "document_not_found" }, 404);
        return c.json(document);
      });
    })
    .delete(
      "/:taskId/documents/:documentId",
      zValidator("param", documentParamSchema),
      async (c) => {
        if (!documents) return c.json({ error: "not_supported" }, 501);
        const { taskId, documentId } = c.req.valid("param");
        return guard("document_error", async () => {
          if (!(await tasks.get(taskId))) return c.json({ error: "task_not_found" }, 404);
          if (!(await documents.delete(taskId, documentId)))
            return c.json({ error: "document_not_found" }, 404);
          return c.body(null, 204);
        });
      },
    );
