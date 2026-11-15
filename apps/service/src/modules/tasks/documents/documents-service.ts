import { guard } from "../../../errors";
import { ExtractionError } from "../../../platform/extract-client";
import {
  DocumentTooLargeError,
  type DocumentSummary,
  type DocumentsStore,
  type StoredDocument,
} from "./documents-store";

export type DocumentsServiceDeps = { documentsStore: DocumentsStore };

export type CreateDocumentResult =
  | { status: "created"; document: DocumentSummary }
  | { status: "document_too_large" | "extraction_failed" };

// Operations on the documents of a task, which the caller has already checked exists.
// Expected outcomes are statuses; a failing dependency throws a DependencyError.
export type DocumentsService = {
  list: (taskId: string) => Promise<DocumentSummary[]>;
  get: (taskId: string, documentId: string) => Promise<StoredDocument | undefined>;
  create: (taskId: string, file: File) => Promise<CreateDocumentResult>;
  // False when the document is not attached to the task.
  delete: (taskId: string, documentId: string) => Promise<boolean>;
};

export const createDocumentsService = ({
  documentsStore,
}: DocumentsServiceDeps): DocumentsService => ({
  list: (taskId) => guard("document_error", () => documentsStore.list(taskId)),
  get: (taskId, documentId) =>
    guard("document_error", () => documentsStore.get(taskId, documentId)),
  create: (taskId, file) =>
    guard("document_error", async (): Promise<CreateDocumentResult> => {
      try {
        return { status: "created", document: await documentsStore.create(taskId, file) };
      } catch (err) {
        if (err instanceof DocumentTooLargeError) return { status: "document_too_large" };
        if (err instanceof ExtractionError) return { status: "extraction_failed" };
        throw err;
      }
    }),
  delete: (taskId, documentId) =>
    guard("document_error", () => documentsStore.delete(taskId, documentId)),
});
