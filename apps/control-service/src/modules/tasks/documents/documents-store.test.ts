import { describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";

import { createDocumentsStore } from "./documents-store";

const file = (text: string, name = "a.txt") => new File([text], name, { type: "text/plain" });
// sha256("hello")
const HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("documents store", () => {
  test("dedups by checksum and removes orphans only after the last detach", async () => {
    const firestore = new Firestore();
    const extracted: string[] = [];
    const extractClient = {
      extract: async (f: File) => {
        extracted.push(f.name);
        return { content: `text:${await f.text()}`, mimeType: "text/plain" };
      },
    };
    const docs = createDocumentsStore({ firestore, extractClient });
    const [t1, t2] = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      for (const id of [t1, t2]) await firestore.collection("tasks").doc(id).set({ documents: [] });

      const first = await docs.create(t1, file("hello"));
      expect(first).toEqual({
        documentId: HELLO,
        filename: "a.txt",
        checksum: HELLO,
        contentType: "text/plain",
      });
      await docs.create(t2, file("hello", "other-name.txt"));
      expect(extracted).toEqual(["a.txt"]);
      expect((await docs.get(t2, HELLO))?.content).toBe("text:hello");
      expect(await docs.list(t1)).toEqual([first]);

      expect(await docs.delete(t1, HELLO)).toBe(true);
      expect(await docs.delete(t1, HELLO)).toBe(false);
      expect((await firestore.collection("documents").doc(HELLO).get()).exists).toBe(true);

      await firestore.collection("tasks").doc(t2).delete();
      await docs.release([HELLO]);
      expect((await firestore.collection("documents").doc(HELLO).get()).exists).toBe(false);
    } finally {
      await Promise.all([
        firestore.collection("tasks").doc(t1).delete(),
        firestore.collection("tasks").doc(t2).delete(),
        firestore.collection("documents").doc(HELLO).delete(),
      ]);
      await firestore.terminate();
    }
  });

  test("create stores the document again when the last holder released it after it was read", async () => {
    const firestore = new Firestore();
    const extractClient = {
      extract: async () => ({ content: "text:hello", mimeType: "text/plain" }),
    };
    const docs = createDocumentsStore({ firestore, extractClient });
    const [t1, t2] = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      for (const id of [t1, t2]) await firestore.collection("tasks").doc(id).set({ documents: [] });
      await docs.create(t1, file("hello"));
      // The second upload reads the stored document; the first task detaches it before the link.
      const original = firestore.collection.bind(firestore);
      let released = false;
      firestore.collection = ((name: string) => {
        const collection = original(name);
        if (name !== "documents") return collection;
        const doc = collection.doc.bind(collection);
        collection.doc = ((id: string) => {
          const ref = doc(id);
          const get = ref.get.bind(ref);
          ref.get = (async () => {
            const snapshot = await get();
            if (!released) {
              released = true;
              await docs.delete(t1, HELLO);
            }
            return snapshot;
          }) as typeof ref.get;
          return ref;
        }) as typeof collection.doc;
        return collection;
      }) as typeof firestore.collection;
      const raced = createDocumentsStore({
        firestore,
        extractClient: {
          extract: async () => {
            throw new Error("must not extract: the document existed when read");
          },
        },
      });
      await raced.create(t2, file("hello"));
      firestore.collection = original;
      expect((await docs.get(t2, HELLO))?.content).toBe("text:hello");
    } finally {
      for (const id of [t1, t2]) await firestore.collection("tasks").doc(id).delete();
      await firestore.collection("documents").doc(HELLO).delete();
    }
  });
});
