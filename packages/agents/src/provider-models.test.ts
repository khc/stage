import { expect, mock, test } from "bun:test";

import type { Firestore } from "@google-cloud/firestore";
import { Gemini, GoogleLLMVariant } from "@google/adk";

import { VertexExpressGemini } from "./model";
import { OpenAiLlm } from "./openai-llm";
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
  await fails(resolve({ ...stored, kind: "anthropic" }));
  await fails(resolve(stored, "gemini-2.5-pro"));
  await fails(resolve(stored, "gemini-9"));
});

test("refuses a provider without a key or with control characters, and says so without leaking anything", async () => {
  expect(await fails(resolve({ ...stored, apiKey: undefined }))).toContain("API key");
  expect(await fails(resolve({ ...stored, apiKey: "" }))).toContain("API key");
  expect(await fails(resolve({ ...stored, apiKey: `${KEY}\r\n` }))).toContain("API key");
  expect(
    await fails(resolve({ ...stored, apiKey: `${KEY.slice(0, 4)}\u0000${KEY.slice(4)}` })),
  ).toContain("API key");
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

test("an openai provider resolves OpenAiLlm with default or custom OpenAI-compatible baseUrl and optional key when custom baseUrl is set", async () => {
  const openaiStored = {
    name: "OpenRouter",
    kind: "openai",
    enabled: true,
    apiKey: KEY,
    models: ["gpt-4o", "meta-llama/llama-3.3-70b"],
  };

  const defaultLlm = await resolve(openaiStored, "gpt-4o");
  expect(defaultLlm).toBeInstanceOf(OpenAiLlm);
  expect(defaultLlm.model).toBe("gpt-4o");

  const compatLlm = await createModelResolver(
    fakeDb({
      ...openaiStored,
      apiKey: undefined,
      baseUrl: "  https://openrouter.ai/api/v1  ",
    }).db,
    { fetcher: async () => Response.json({}) },
  )({ providerId, model: "meta-llama/llama-3.3-70b" });
  expect(compatLlm).toBeInstanceOf(OpenAiLlm);
  expect(compatLlm.model).toBe("meta-llama/llama-3.3-70b");

  await fails(resolve({ ...openaiStored, apiKey: undefined }, "gpt-4o"));
  await fails(
    resolve({ ...openaiStored, baseUrl: "http://169.254.169.254/latest/meta-data" }, "gpt-4o"),
  );
});
