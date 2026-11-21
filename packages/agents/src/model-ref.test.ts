import { expect, test } from "bun:test";

import { isSelectableModel, modelRefSchema, RUNNABLE_KINDS } from "./model-ref";

const provider = {
  enabled: true,
  kind: "google-express",
  models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  disabledModels: ["gemini-2.5-pro"],
};

// The same case table lives in apps/ui/src/lib/models.test.ts for the UI's mirror of this rule.
test("a model is selectable only on an enabled provider of a runnable kind, in models and not disabled", () => {
  expect(isSelectableModel(provider, "gemini-2.5-flash")).toBe(true);
  expect(isSelectableModel({ ...provider, enabled: false }, "gemini-2.5-flash")).toBe(false);
  expect(isSelectableModel({ ...provider, kind: "openai" }, "gemini-2.5-flash")).toBe(false);
  expect(isSelectableModel(provider, "gemini-9")).toBe(false);
  expect(isSelectableModel(provider, "gemini-2.5-pro")).toBe(false);
  expect(isSelectableModel({ enabled: true, kind: "google" }, "gemini-2.5-flash")).toBe(false);
  expect(isSelectableModel({ ...provider, disabledModels: undefined }, "gemini-2.5-pro")).toBe(
    true,
  );
});

test("google and google-express can run", () => {
  expect([...RUNNABLE_KINDS]).toEqual(["google", "google-express"]);
});

test("a model ref needs a provider uuid and a model name", () => {
  const providerId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";
  expect(modelRefSchema.safeParse({ providerId, model: "m" }).success).toBe(true);
  expect(modelRefSchema.safeParse({ providerId: "x", model: "m" }).success).toBe(false);
  expect(modelRefSchema.safeParse({ providerId, model: "  " }).success).toBe(false);
});
