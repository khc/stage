import { FieldValue, type Firestore } from "@google-cloud/firestore";

import type { ExtractClient } from "../../../platform/extract-client";

export type DocumentSummary = {
  documentId: string;
  filename: string;
  checksum: string;
  contentType: string;
};
export type StoredDocument = DocumentSummary & { content: string };

export type DocumentsStore = {
  list: (taskId: string) => Promise<DocumentSummary[]>;
  get: (taskId: string, documentId: string) => Promise<StoredDocument | undefined>;
  create: (taskId: string, file: File) => Promise<DocumentSummary>;
  // False when the document is not attached to the task.
  delete: (taskId: string, documentId: string) => Promise<boolean>;
  // Deletes the documents no task uses any more.
  release: (documentIds: string[]) => Promise<void>;
};

export type DocumentsStoreDeps = { firestore: Firestore; extractClient: ExtractClient };

// Firestore documents are limited to 1 MiB; leave room for the other fields.
export const MAX_CONTENT_BYTES = 900_000;
export class DocumentTooLargeError extends Error {}

const toDocumentSummary = (id: string, data: FirebaseFirestore.DocumentData): DocumentSummary => ({
  documentId: id,
  filename: data.filename,
  checksum: data.checksum,
  contentType: data.contentType,
});

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const createDocumentsStore = ({
  firestore,
  extractClient,
}: DocumentsStoreDeps): DocumentsStore => {
  const tasks = firestore.collection("tasks");
  const documents = firestore.collection("documents");
  const linked = async (taskId: string): Promise<string[]> =>
    ((await tasks.doc(taskId).get()).get("documents") ?? []).map(
      (ref: { documentId: string }) => ref.documentId,
    );

  const release: DocumentsStore["release"] = async (documentIds) => {
    for (const documentId of documentIds) {
      const stillUsed = await tasks
        .where("documents", "array-contains", { documentId })
        .limit(1)
        .get();
      if (stillUsed.empty) await documents.doc(documentId).delete();
    }
  };

  return {
    async list(taskId) {
      const ids = await linked(taskId);
      if (!ids.length) return [];
      const snaps = await firestore.getAll(...ids.map((id) => documents.doc(id)));
      return snaps.filter((s) => s.exists).map((s) => toDocumentSummary(s.id, s.data()!));
    },
    async get(taskId, documentId) {
      if (!(await linked(taskId)).includes(documentId)) return undefined;
      const snap = await documents.doc(documentId).get();
      return snap.exists
        ? { ...toDocumentSummary(snap.id, snap.data()!), content: snap.get("content") }
        : undefined;
    },
    async create(taskId, file) {
      const checksum = sha256(new Uint8Array(await file.arrayBuffer()));
      const ref = documents.doc(checksum);
      const existing = await ref.get();
      let result: DocumentSummary;
      if (existing.exists) {
        result = toDocumentSummary(checksum, existing.data()!);
      } else {
        const { content, mimeType } = await extractClient.extract(file);
        if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new DocumentTooLargeError();
        const data = {
          filename: file.name,
          checksum,
          contentType: mimeType || file.type,
          content,
        };
        await ref.set(data);
        result = toDocumentSummary(checksum, data);
      }
      await tasks
        .doc(taskId)
        .update({ documents: FieldValue.arrayUnion({ documentId: checksum }) });
      return result;
    },
    async delete(taskId, documentId) {
      if (!(await linked(taskId)).includes(documentId)) return false;
      await tasks.doc(taskId).update({ documents: FieldValue.arrayRemove({ documentId }) });
      await release([documentId]);
      return true;
    },
    release,
  };
};
