import { t } from "elysia";

const taskId = t.String({ format: "uuid" });
const documentId = t.String({ pattern: "^[0-9a-f]{64}$" });

export const DocumentsModel = {
  taskParams: t.Object({ taskId }),
  params: t.Object({ taskId, documentId }),
  // Response shapes, used only to document the API.
  summary: t.Object({
    documentId: t.String(),
    filename: t.String(),
    checksum: t.String(),
    contentType: t.String(),
  }),
} as const;

export type DocumentsModel = {
  [K in keyof typeof DocumentsModel]: (typeof DocumentsModel)[K]["static"];
};

// A larger upload is refused with 413 before it is read.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
