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
});
