import { expect, mock, test } from "bun:test";

import type { Firestore } from "@google-cloud/firestore";
import { Gemini, GoogleLLMVariant } from "@google/adk";

import { VertexExpressGemini } from "./model";
import { ModelUnavailableError, createModelResolver } from "./provider-models";

const providerId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";
const KEY = "SECRET-KEY-do-not-log";
const stored = {
  name: "My Gemini",
  kind: "google",
  enabled: true,
  apiKey: KEY,
  models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  disabledModels: ["gemini-2.5-pro"],
};

const fakeDb = (data?: Record<string, unknown>) => {
  const doc = mock((_id: string) => ({
    get: async () => ({ exists: !!data, get: (field: string) => data?.[field] }),
  }));
  const collection = mock((_name: string) => ({ doc }));
  return { db: { collection } as unknown as Pick<Firestore, "collection">, collection, doc };
};

const resolve = (data: Record<string, unknown> | undefined, model = "gemini-2.5-flash") =>
  createModelResolver(fakeDb(data).db)({ providerId, model });

const fails = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e) => e,
  );
  expect(error).toBeInstanceOf(ModelUnavailableError);
  expect((error as Error).message).not.toContain(KEY);
  return (error as Error).message;
};

test("a google provider gives a Gemini API model with its key", async () => {
  const llm = await resolve(stored);
  expect(llm).toBeInstanceOf(Gemini);
  expect(llm.model).toBe("gemini-2.5-flash");
  expect((llm as Gemini).apiBackend).toBe(GoogleLLMVariant.GEMINI_API);
});

test("a google-express provider gives a Vertex AI express model", async () => {
  const llm = await resolve({ ...stored, kind: "google-express" });
  expect(llm).toBeInstanceOf(VertexExpressGemini);
  expect(llm.model).toBe("gemini-2.5-flash");
  expect((llm as VertexExpressGemini).apiBackend).toBe(GoogleLLMVariant.VERTEX_AI);
});

test("reads exactly one provider document, by id", async () => {
  const { db, collection, doc } = fakeDb(stored);
  await createModelResolver(db)({ providerId, model: "gemini-2.5-flash" });
  expect(collection).toHaveBeenCalledWith("providers");
  expect(doc).toHaveBeenCalledWith(providerId);
});

test("refuses a missing, disabled or unsupported provider, and a model that is not offered", async () => {
  await fails(resolve(undefined));
  await fails(resolve({ ...stored, enabled: false }));
  await fails(resolve({ ...stored, kind: "openai" }));
  await fails(resolve(stored, "gemini-2.5-pro"));
  await fails(resolve(stored, "gemini-9"));
});

test("refuses a provider without a key, and says so without leaking anything", async () => {
  expect(await fails(resolve({ ...stored, apiKey: undefined }))).toContain("API key");
  expect(await fails(resolve({ ...stored, apiKey: "" }))).toContain("API key");
});

test("a google provider with a custom base URL is refused, the default URL is fine", async () => {
  expect(
    await fails(resolve({ ...stored, baseUrl: "https://proxy.example.com/v1beta" })),
  ).toContain("Base URL");
  expect(
    await resolve({ ...stored, baseUrl: "https://generativelanguage.googleapis.com/v1beta/" }),
  ).toBeInstanceOf(Gemini);
});

test("an express provider ignores its base URL, which Express does not use", async () => {
  const llm = await resolve({
    ...stored,
    kind: "google-express",
    baseUrl: "https://x.example.com",
  });
  expect(llm).toBeInstanceOf(VertexExpressGemini);
});
