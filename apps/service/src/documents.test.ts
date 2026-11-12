import { describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";

import { createTaskDocuments } from "./documents";

const file = (text: string, name = "a.txt") => new File([text], name, { type: "text/plain" });
// sha256("hello")
const HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("task documents in Firestore", () => {
  test("dedups by checksum and removes orphans only after the last detach", async () => {
    const db = new Firestore();
    const extracted: string[] = [];
    const docs = createTaskDocuments(db, async (f) => {
      extracted.push(f.name);
      return { content: `text:${await f.text()}`, mimeType: "text/plain" };
    });
    const [t1, t2] = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      for (const id of [t1, t2]) await db.collection("tasks").doc(id).set({ documents: [] });

      const first = await docs.add(t1, file("hello"));
      expect(first).toEqual({
        documentId: HELLO,
        filename: "a.txt",
        checksum: HELLO,
        contentType: "text/plain",
      });
      await docs.add(t2, file("hello", "other-name.txt"));
      expect(extracted).toEqual(["a.txt"]);
      expect((await docs.get(t2, HELLO))?.content).toBe("text:hello");
      expect(await docs.list(t1)).toEqual([first]);

      expect(await docs.remove(t1, HELLO)).toBe(true);
      expect(await docs.remove(t1, HELLO)).toBe(false);
      expect((await db.collection("documents").doc(HELLO).get()).exists).toBe(true);

      await db.collection("tasks").doc(t2).delete();
      await docs.release([HELLO]);
      expect((await db.collection("documents").doc(HELLO).get()).exists).toBe(false);
    } finally {
      await Promise.all([
        db.collection("tasks").doc(t1).delete(),
        db.collection("tasks").doc(t2).delete(),
        db.collection("documents").doc(HELLO).delete(),
      ]);
      await db.terminate();
    }
  });
});
