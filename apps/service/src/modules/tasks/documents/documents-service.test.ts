import { describe, expect, test } from "bun:test";

import { DependencyError } from "../../../errors";
import { ExtractionError } from "../../../platform/extract-client";
import { createDocumentsService } from "./documents-service";
import { DocumentTooLargeError, type DocumentsStore } from "./documents-store";

const file = new File(["hi"], "a.txt");
const summary = { documentId: "d", filename: "a.txt", checksum: "d", contentType: "text/plain" };
const serviceWith = (overrides: Partial<DocumentsStore>) =>
  createDocumentsService({
    documentsStore: { create: async () => summary, ...overrides } as unknown as DocumentsStore,
  });

describe("documents service create", () => {
  test("returns the created document", async () => {
    expect(await serviceWith({}).create("t", file)).toEqual({
      status: "created",
      document: summary,
    });
  });

  test.each([
    [new DocumentTooLargeError(), "document_too_large"],
    [new ExtractionError("bad"), "extraction_failed"],
  ] as const)("turns %o into the status %s", async (failure, status) => {
    const service = serviceWith({ create: async () => Promise.reject(failure) });
    expect(await service.create("t", file)).toEqual({ status });
  });

  test("any other failure is a document_error dependency error", async () => {
    const service = serviceWith({
      create: async () => Promise.reject(new Error("firestore down")),
    });
    const err = await service.create("t", file).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe("document_error");
  });
});
