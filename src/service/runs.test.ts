import { Firestore } from "@google-cloud/firestore";
import { describe, expect, mock, test } from "bun:test";
import { createCreateRun, createListRuns, createGetRun } from "./runs";

const writer = (write = async (_data: unknown) => {}) => {
  const create = mock(write);
  const doc = mock((_id: string) => ({ create }));
  const collection = mock((_name: string) => ({ doc }));
  return {
    db: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
    create,
  };
};

test("creates UUID-keyed contracts in runs and preserves the supplied prompt", async () => {
  const { db, collection, doc, create } = writer();
  const save = createCreateRun(db);
  const contract = await save("  hello  ");
  expect(contract.runId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(contract.prompt).toBe("  hello  ");
  expect(collection).toHaveBeenCalledWith("runs");
  expect(doc).toHaveBeenCalledWith(contract.runId);
  expect(create).toHaveBeenCalledWith(contract);
  expect((await save("second")).runId).not.toBe(contract.runId);
});

test("waits for persistence before returning the contract", async () => {
  const deferred = Promise.withResolvers<void>();
  const { db, create } = writer(() => deferred.promise);
  let settled = false;
  const saved = createCreateRun(db)("hello").then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  deferred.resolve();
  expect((await saved).prompt).toBe("hello");
});

test("propagates a failed create without retrying", async () => {
  const { db, create } = writer(async () => {
    throw new Error("write failed");
  });
  await expect(createCreateRun(db)("hello")).rejects.toThrow("write failed");
  expect(create).toHaveBeenCalledTimes(1);
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  "run contracts in Firestore",
  () => {
    test("persists a contract across clients", async () => {
      const db = new Firestore();
      const reader = new Firestore();
      let runId: string | undefined;
      try {
        const contract = await createCreateRun(db)("emulator prompt");
        runId = contract.runId;
        expect(
          (await reader.collection("runs").doc(runId).get()).data(),
        ).toEqual(contract);
        expect(await createGetRun(reader)(runId)).toEqual(contract);
        expect(await createListRuns(reader)()).toContainEqual(contract);
        await db.collection("runs").doc(runId).delete();
        expect(await createGetRun(reader)(runId)).toBeUndefined();
      } finally {
        if (runId) await db.collection("runs").doc(runId).delete();
        await Promise.all([db.terminate(), reader.terminate()]);
      }
    });
  },
);

const snapshot = (id: string, prompt: string) => ({
  id,
  exists: true,
  get: (field: string) => ({ prompt, runId: "ignored", extra: true })[field],
});
const readerWith = (
  get: () => Promise<unknown>,
  list: () => Promise<unknown>,
) => {
  const doc = mock((_id: string) => ({ get }));
  const collection = mock((_name: string) => ({ doc, get: list }));
  return {
    db: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
  };
};

test("lists only contract fields using document IDs", async () => {
  const { db, collection } = readerWith(
    async () => undefined,
    async () => ({ docs: [snapshot("a", "one"), snapshot("b", "two")] }),
  );
  expect(await createListRuns(db)()).toEqual([
    { runId: "a", prompt: "one" },
    { runId: "b", prompt: "two" },
  ]);
  expect(collection).toHaveBeenCalledWith("runs");
});

test("lists an empty collection", async () => {
  const { db } = readerWith(
    async () => undefined,
    async () => ({ docs: [] }),
  );
  expect(await createListRuns(db)()).toEqual([]);
});

test("gets a contract by document ID without extra stored fields", async () => {
  const { db, collection, doc } = readerWith(
    async () => snapshot("a", "one"),
    async () => undefined,
  );
  expect(await createGetRun(db)("a")).toEqual({ runId: "a", prompt: "one" });
  expect(collection).toHaveBeenCalledWith("runs");
  expect(doc).toHaveBeenCalledWith("a");
});

test("returns undefined for a missing document", async () => {
  const { db } = readerWith(
    async () => ({ exists: false }),
    async () => undefined,
  );
  expect(await createGetRun(db)("missing")).toBeUndefined();
});

test("propagates list and lookup failures", async () => {
  const fail = async () => {
    throw new Error("read failed");
  };
  const { db } = readerWith(fail, fail);
  await expect(createListRuns(db)()).rejects.toThrow("read failed");
  await expect(createGetRun(db)("a")).rejects.toThrow("read failed");
});
