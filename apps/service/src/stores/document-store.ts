import { FieldValue, type Firestore } from "@google-cloud/firestore";

export type DocumentSummary = {
  documentId: string;
  filename: string;
  checksum: string;
  contentType: string;
};
export type StoredDocument = DocumentSummary & { content: string };
export type ExtractDocument = (file: File) => Promise<{ content: string; mimeType: string }>;
export type DocumentStore = {
  list: (taskId: string) => Promise<DocumentSummary[]>;
  get: (taskId: string, documentId: string) => Promise<StoredDocument | undefined>;
  create: (taskId: string, file: File) => Promise<DocumentSummary>;
  delete: (taskId: string, documentId: string) => Promise<boolean>;
  release: (documentIds: string[]) => Promise<void>;
};

// Firestore documents are limited to 1 MiB; leave room for the other fields.
export const MAX_CONTENT_BYTES = 900_000;
export class DocumentTooLargeError extends Error {}
export class ExtractionError extends Error {}

export const createExtractDocument =
  (baseUrl: string): ExtractDocument =>
  async (file) => {
    const form = new FormData();
    form.set("file", file, file.name);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      body: form,
    });
    if (res.status === 422) throw new ExtractionError(await res.text());
    if (!res.ok) throw new Error(`extract service failed: HTTP ${res.status}`);
    return res.json() as Promise<{ content: string; mimeType: string }>;
  };

const summary = (id: string, data: FirebaseFirestore.DocumentData): DocumentSummary => ({
  documentId: id,
  filename: data.filename,
  checksum: data.checksum,
  contentType: data.contentType,
});

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const createDocumentStore = (db: Firestore, extract: ExtractDocument): DocumentStore => {
  const tasks = db.collection("tasks");
  const documents = db.collection("documents");
  const linked = async (taskId: string): Promise<string[]> =>
    ((await tasks.doc(taskId).get()).get("documents") ?? []).map(
      (ref: { documentId: string }) => ref.documentId,
    );

  const release: DocumentStore["release"] = async (documentIds) => {
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
      const snaps = await db.getAll(...ids.map((id) => documents.doc(id)));
      return snaps.filter((s) => s.exists).map((s) => summary(s.id, s.data()!));
    },
    async get(taskId, documentId) {
      if (!(await linked(taskId)).includes(documentId)) return undefined;
      const snap = await documents.doc(documentId).get();
      return snap.exists
        ? { ...summary(snap.id, snap.data()!), content: snap.get("content") }
        : undefined;
    },
    async create(taskId, file) {
      const checksum = sha256(new Uint8Array(await file.arrayBuffer()));
      const ref = documents.doc(checksum);
      const existing = await ref.get();
      let result: DocumentSummary;
      if (existing.exists) {
        result = summary(checksum, existing.data()!);
      } else {
        const { content, mimeType } = await extract(file);
        if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new DocumentTooLargeError();
        const data = {
          filename: file.name,
          checksum,
          contentType: mimeType || file.type,
          content,
        };
        await ref.set(data);
        result = summary(checksum, data);
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
