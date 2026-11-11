import { expect, test } from "bun:test";
import { VertexExpressGemini, createModel } from "./model";

test("defaults to the plain gemini-2.5-flash model name", () => {
  expect(createModel({})).toBe("gemini-2.5-flash");
});

test("treats an empty AGENT_MODEL as unset on both paths", () => {
  expect(createModel({ AGENT_MODEL: "" })).toBe("gemini-2.5-flash");
  expect(
    (
      createModel({
        AGENT_MODEL: "",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GEMINI_API_KEY: "k",
      }) as VertexExpressGemini
    ).model,
  ).toBe("gemini-2.5-flash");
});

test("uses AGENT_MODEL as a plain model name when the Vertex flag is off", () => {
  expect(createModel({ AGENT_MODEL: "gemini-x", GEMINI_API_KEY: "k" })).toBe("gemini-x");
});

test("with the Vertex flag and an API key, returns a Vertex AI express client", () => {
  const model = createModel({
    AGENT_MODEL: "publishers/google/models/gemini-3-flash-preview",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    GEMINI_API_KEY: "k",
  });

  expect(model).toBeInstanceOf(VertexExpressGemini);
  expect((model as VertexExpressGemini).model).toBe(
    "publishers/google/models/gemini-3-flash-preview",
  );
  expect((model as VertexExpressGemini).apiClient.vertexai).toBe(true);
});

test("accepts any of the ADK API key variables", () => {
  for (const name of ["GOOGLE_GENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) {
    expect(createModel({ GOOGLE_GENAI_USE_VERTEXAI: "1", [name]: "k" })).toBeInstanceOf(
      VertexExpressGemini,
    );
  }
});

test("with the Vertex flag but no API key, leaves the model name to ADK's own Vertex path", () => {
  expect(
    createModel({ GOOGLE_GENAI_USE_VERTEXAI: "true", AGENT_MODEL: "gemini-x" }),
  ).toBe("gemini-x");
});
