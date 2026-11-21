import { describe, expect, test } from "bun:test";

import { FieldValue, type Firestore } from "@google-cloud/firestore";

import { createProvidersStore } from "./providers-store";

const isDeleteSentinel = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  value.constructor?.name === FieldValue.delete().constructor?.name;

const fakeDb = (initial: Record<string, Record<string, unknown>> = {}) => {
  const stored = new Map<string, Record<string, unknown>>(
    Object.entries(initial).map(([id, data]) => [id, { ...data }]),
  );
  const lastUpdates: Record<string, unknown>[] = [];

  const makeRef = (id: string) => ({
    id,
    create: async (data: Record<string, unknown>) => {
      if (stored.has(id)) throw new Error(`Already exists: ${id}`);
      stored.set(id, { ...data });
    },
    get: async () => ({
      exists: stored.has(id),
      id,
      data: () => (stored.has(id) ? { ...stored.get(id)! } : undefined),
    }),
    delete: async () => {
      stored.delete(id);
    },
  });

  const firestore = {
    collection: (name: string) => {
      expect(name).toBe("providers");
      return {
        doc: (id: string) => makeRef(id),
        get: async () => ({
          docs: [...stored.entries()].map(([id, data]) => ({
            exists: true,
            id,
            data: () => ({ ...data }),
          })),
        }),
      };
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      let wrote = false;
      const pending: Array<() => void> = [];
      const tx = {
        get: async (ref: ReturnType<typeof makeRef>) => {
          if (wrote) throw new Error("Firestore transaction read after write");
          return ref.get();
        },
        update: (ref: ReturnType<typeof makeRef>, updates: Record<string, unknown>) => {
          wrote = true;
          lastUpdates.push(updates);
          pending.push(() => {
            const current = { ...stored.get(ref.id) };
            for (const [key, value] of Object.entries(updates)) {
              if (isDeleteSentinel(value)) delete current[key];
              else current[key] = value;
            }
            stored.set(ref.id, current);
          });
        },
      };
      const result = await fn(tx);
      for (const apply of pending) apply();
      return result;
    },
  } as unknown as Pick<Firestore, "collection" | "runTransaction">;

  return { firestore, stored, lastUpdates };
};

describe("providers store", () => {
  test("creates a UUID-keyed provider, stores apiKey, and never returns raw apiKey", async () => {
    const { firestore, stored } = fakeDb();
    const store = createProvidersStore(firestore);

    const created = await store.create({
      name: "OpenAI Prod",
      kind: "openai",
      apiKey: "sk-proj-secret-9876",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4o-mini"],
    });

    expect(created.providerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(created).toMatchObject({
      name: "OpenAI Prod",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4o-mini"],
      enabled: true,
      hasApiKey: true,
      apiKeyHint: "••••9876",
    });
    expect("apiKey" in created).toBe(false);
    expect(stored.get(created.providerId)?.apiKey).toBe("sk-proj-secret-9876");

    const fetched = await store.get(created.providerId);
    expect(fetched).toEqual(created);
    expect("apiKey" in fetched!).toBe(false);
  });

  test("masks short apiKeys (< 12 chars) without leaking characters", async () => {
    const { firestore } = fakeDb();
    const store = createProvidersStore(firestore);

    for (const shortKey of ["abc", "abcd", "sk-12345678"]) {
      const created = await store.create({
        name: "Short",
        kind: "google",
        apiKey: shortKey,
      });
      expect(created.hasApiKey).toBe(true);
      expect(created.apiKeyHint).toBe("••••");
      expect("apiKey" in created).toBe(false);
    }
  });

  test("lists providers sorted by createdAt then providerId without raw apiKeys", async () => {
    const { firestore } = fakeDb({
      "00000000-0000-4000-8000-000000000002": {
        providerId: "00000000-0000-4000-8000-000000000002",
        name: "B",
        kind: "openai",
        enabled: true,
        createdAt: 100,
        updatedAt: 100,
        apiKey: "sk-secret-key-b",
      },
      "00000000-0000-4000-8000-000000000001": {
        providerId: "00000000-0000-4000-8000-000000000001",
        name: "A",
        kind: "google",
        enabled: false,
        createdAt: 100,
        updatedAt: 100,
      },
      "00000000-0000-4000-8000-000000000003": {
        providerId: "00000000-0000-4000-8000-000000000003",
        name: "First",
        kind: "google",
        enabled: true,
        createdAt: 50,
        updatedAt: 50,
      },
    });
    const list = await createProvidersStore(firestore).list();
    expect(list.map((p) => p.name)).toEqual(["First", "A", "B"]);
    expect(list.every((p) => !("apiKey" in p))).toBe(true);
    expect(list[1]!.hasApiKey).toBe(false);
    expect(list[2]!.apiKeyHint).toBe("••••ey-b");
  });

  test("updates fields, preserves omitted apiKey, clears null fields with FieldValue.delete(), and returns undefined when missing", async () => {
    const { firestore, stored, lastUpdates } = fakeDb();
    const store = createProvidersStore(firestore);

    expect(await store.update("missing-id", { name: "X" })).toBeUndefined();

    const created = await store.create({
      name: "Google",
      kind: "google",
      apiKey: "AIza-test-1234",
      baseUrl: "https://example.test",
      defaultModel: "gemini-2.5-flash",
      models: ["gemini-2.5-flash"],
    });

    // Switching models off is stored beside the model list and cleared with null.
    const switched = await store.update(created.providerId, {
      disabledModels: ["gemini-2.5-flash"],
    });
    expect(switched?.disabledModels).toEqual(["gemini-2.5-flash"]);
    expect(
      (await store.update(created.providerId, { disabledModels: null }))?.disabledModels,
    ).toBeUndefined();

    const renamed = await store.update(created.providerId, {
      name: "Google Updated",
      enabled: false,
    });
    expect(renamed).toMatchObject({
      providerId: created.providerId,
      name: "Google Updated",
      enabled: false,
      hasApiKey: true,
      apiKeyHint: "••••1234",
      baseUrl: "https://example.test",
    });
    expect("apiKey" in renamed!).toBe(false);
    expect(stored.get(created.providerId)?.apiKey).toBe("AIza-test-1234");

    const cleared = await store.update(created.providerId, {
      apiKey: null,
      baseUrl: null,
      defaultModel: null,
      models: null,
    });
    expect(cleared).toMatchObject({
      providerId: created.providerId,
      name: "Google Updated",
      hasApiKey: false,
    });
    expect(cleared?.apiKeyHint).toBeUndefined();
    expect(cleared?.baseUrl).toBeUndefined();
    expect(cleared?.defaultModel).toBeUndefined();
    expect(cleared?.models).toBeUndefined();
    expect(stored.get(created.providerId)?.apiKey).toBeUndefined();
    expect(isDeleteSentinel(lastUpdates.at(-1)?.apiKey)).toBe(true);
    expect(isDeleteSentinel(lastUpdates.at(-1)?.baseUrl)).toBe(true);
  });

  test("deletes existing provider and returns false when missing", async () => {
    const { firestore } = fakeDb();
    const store = createProvidersStore(firestore);

    const created = await store.create({ name: "Temp", kind: "openai" });
    expect(await store.delete(created.providerId)).toBe(true);
    expect(await store.get(created.providerId)).toBeUndefined();
    expect(await store.delete(created.providerId)).toBe(false);
  });

  test("getCredentials returns stored kind, apiKey, and baseUrl internally without exposing on summaries", async () => {
    const { firestore } = fakeDb();
    const store = createProvidersStore(firestore);

    expect(await store.getCredentials("missing")).toBeUndefined();
    const created = await store.create({
      name: "OpenAI",
      kind: "openai",
      apiKey: "sk-internal-123456",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(await store.getCredentials(created.providerId)).toEqual({
      kind: "openai",
      apiKey: "sk-internal-123456",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  test("update clears saved apiKey when kind or baseUrl changes without a new apiKey", async () => {
    const { firestore, stored } = fakeDb();
    const store = createProvidersStore(firestore);

    const created = await store.create({
      name: "OpenAI",
      kind: "openai",
      apiKey: "sk-internal-123456",
      baseUrl: "https://api.openai.com/v1",
    });

    // Updating unrelated fields while keeping kind/baseUrl identical preserves apiKey.
    const untouchedEndpoint = await store.update(created.providerId, {
      name: "Renamed",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(untouchedEndpoint?.hasApiKey).toBe(true);
    expect(stored.get(created.providerId)?.apiKey).toBe("sk-internal-123456");

    // Changing baseUrl without specifying apiKey clears stored apiKey.
    const urlChanged = await store.update(created.providerId, {
      baseUrl: "https://other-proxy.example/v1",
    });
    expect(urlChanged?.hasApiKey).toBe(false);
    expect(urlChanged?.apiKeyHint).toBeUndefined();
    expect(stored.get(created.providerId)?.apiKey).toBeUndefined();

    // Changing kind with a new apiKey saves the new key cleanly.
    const withNewKey = await store.update(created.providerId, {
      kind: "google",
      apiKey: "AIza-new-key-1234",
    });
    expect(withNewKey?.hasApiKey).toBe(true);
    expect(stored.get(created.providerId)?.apiKey).toBe("AIza-new-key-1234");
  });
});
