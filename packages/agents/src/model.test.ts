import { expect, test } from "bun:test";

import {
  BaseLlm,
  Gemini,
  GoogleLLMVariant,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";

import { VertexExpressGemini, createModel, createRoutedLlm, runWithModel } from "./model";

class FakeLlm extends BaseLlm {
  requests: { model?: string; stream?: boolean; signal?: AbortSignal }[] = [];
  connected = 0;
  constructor(model: string) {
    super({ model });
  }
  // oxlint-disable-next-line require-yield
  async *generateContentAsync(
    request: LlmRequest,
    stream?: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push({ model: request.model, stream, signal });
    yield { content: { role: "model", parts: [{ text: this.model }] } } as LlmResponse;
  }
  async connect(): Promise<BaseLlmConnection> {
    this.connected++;
    return {} as BaseLlmConnection;
  }
}

const ask = async (llm: BaseLlm, stream = false, signal?: AbortSignal) => {
  const texts: string[] = [];
  for await (const response of llm.generateContentAsync(
    { model: llm.model } as LlmRequest,
    stream,
    signal,
  ))
    texts.push(response.content?.parts?.[0]?.text ?? "");
  return texts;
};

test("defaults to the plain gemini-2.5-flash model name", () => {
  expect(createModel({}).model).toBe("gemini-2.5-flash");
});

test("treats an empty AGENT_MODEL as unset on both paths", () => {
  expect(createModel({ AGENT_MODEL: "" }).model).toBe("gemini-2.5-flash");
  expect(
    createModel({ AGENT_MODEL: "", GOOGLE_GENAI_USE_VERTEXAI: "true", GEMINI_API_KEY: "k" }).model,
  ).toBe("gemini-2.5-flash");
});

test("uses AGENT_MODEL as the model name", () => {
  expect(createModel({ AGENT_MODEL: "gemini-x", GEMINI_API_KEY: "k" }).model).toBe("gemini-x");
  expect(createModel({ GOOGLE_GENAI_USE_VERTEXAI: "true", AGENT_MODEL: "gemini-x" }).model).toBe(
    "gemini-x",
  );
});

test("builds nothing until the first call, so loading an agent needs no credentials", () => {
  expect(() => createModel({})).not.toThrow();
  expect(() => createModel({ GOOGLE_GENAI_USE_VERTEXAI: "true" })).not.toThrow();
});

test("with the Vertex flag and an API key, the default model is a Vertex AI express client", () => {
  const express = new VertexExpressGemini({
    model: "publishers/google/models/gemini-3-flash-preview",
    apiKey: "k",
  });
  expect(express.apiClient.vertexai).toBe(true);
  const routed = createModel({
    AGENT_MODEL: "publishers/google/models/gemini-3-flash-preview",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    GEMINI_API_KEY: "k",
  });
  expect(routed.model).toBe("publishers/google/models/gemini-3-flash-preview");
  expect((routed as unknown as { apiBackend: unknown }).apiBackend).toBe(
    GoogleLLMVariant.VERTEX_AI,
  );
});

test("accepts any of the ADK API key variables", () => {
  for (const name of ["GOOGLE_GENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) {
    const routed = createModel({ GOOGLE_GENAI_USE_VERTEXAI: "1", [name]: "k" });
    expect((routed as unknown as { apiBackend: unknown }).apiBackend).toBe(
      GoogleLLMVariant.VERTEX_AI,
    );
  }
});

test("outside a run every call goes to the default model", async () => {
  const fallback = new FakeLlm("env-model");
  const routed = createRoutedLlm("env-model", () => fallback);
  expect(await ask(routed)).toEqual(["env-model"]);
  expect(fallback.requests).toHaveLength(1);
});

test("inside a run every call goes to the chosen model, and the request names that model", async () => {
  const fallback = new FakeLlm("env-model");
  const chosen = new FakeLlm("chosen-model");
  const routed = createRoutedLlm("env-model", () => fallback);
  const signal = new AbortController().signal;
  const texts = await runWithModel(chosen, () => ask(routed, true, signal));
  expect(texts).toEqual(["chosen-model"]);
  expect(chosen.requests).toEqual([{ model: "chosen-model", stream: true, signal }]);
  expect(fallback.requests).toHaveLength(0);
});

test("two runs in flight at once each keep their own model", async () => {
  const routed = createRoutedLlm("env-model", () => new FakeLlm("env-model"));
  const [a, b] = [new FakeLlm("model-a"), new FakeLlm("model-b")];
  const slow = (llm: FakeLlm, ms: number) =>
    runWithModel(llm, async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ask(routed);
    });
  expect(await Promise.all([slow(a, 20), slow(b, 1)])).toEqual([["model-a"], ["model-b"]]);
});

test("a live connection is opened on the chosen model", async () => {
  const fallback = new FakeLlm("env-model");
  const chosen = new FakeLlm("chosen-model");
  const routed = createRoutedLlm("env-model", () => fallback);
  await runWithModel(chosen, () => routed.connect({} as LlmRequest));
  expect(chosen.connected).toBe(1);
  expect(fallback.connected).toBe(0);
});

test("the wrapper reports the backend of the model in use, as ADK reads it for output schemas", async () => {
  const routed = createRoutedLlm(
    "env-model",
    () => new Gemini({ model: "env-model", apiKey: "k", vertexai: false }),
  );
  const apiBackend = () => (routed as unknown as { apiBackend: unknown }).apiBackend;
  expect(apiBackend()).toBe(GoogleLLMVariant.GEMINI_API);
  const express = new VertexExpressGemini({ model: "m", apiKey: "k" });
  expect(await runWithModel(express, async () => apiBackend())).toBe(GoogleLLMVariant.VERTEX_AI);
  // ADK recognises a Gemini by this symbol; without it the wrapper's backend would be ignored.
  expect((routed as unknown as Record<symbol, unknown>)[Symbol.for("google.adk.geminiModel")]).toBe(
    true,
  );
  expect((routed as unknown as { useInteractionsApi: boolean }).useInteractionsApi).toBe(false);
});
