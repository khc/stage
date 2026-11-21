import { expect, test } from "bun:test";

import type { Provider } from "@/lib/api";

import {
  modelOptions,
  needsSwitchConfirmation,
  pickedModel,
  sameModel,
  usableModel,
} from "./models";

const express = {
  providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
  name: "Express",
  kind: "google-express",
  enabled: true,
  hasApiKey: true,
  models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  disabledModels: ["gemini-2.5-pro"],
  createdAt: 1,
  updatedAt: 1,
} as Provider;

// The same case table as packages/agents/src/model-ref.test.ts, for the UI's copy of the rule.
test("a model is offered only on an enabled provider of a runnable kind, in models and not disabled", () => {
  const offered = (provider: Provider, model = "gemini-2.5-flash") =>
    modelOptions([provider]).some((option) => option.ref.model === model);
  expect(offered(express)).toBe(true);
  expect(offered({ ...express, enabled: false })).toBe(false);
  expect(offered({ ...express, kind: "openai" })).toBe(false);
  expect(offered(express, "gemini-2.5-pro")).toBe(false);
  expect(offered({ ...express, models: undefined })).toBe(false);
  expect(offered({ ...express, disabledModels: undefined }, "gemini-2.5-pro")).toBe(true);
});

test("options are labelled Provider · model and carry the ref", () => {
  expect(modelOptions([express])).toEqual([
    {
      ref: { providerId: express.providerId, model: "gemini-2.5-flash" },
      label: "Express · gemini-2.5-flash",
    },
  ]);
  expect(modelOptions([])).toEqual([]);
});

test("a saved model is usable only while it is among the options", () => {
  const options = modelOptions([express]);
  const ref = { providerId: express.providerId, model: "gemini-2.5-flash" };
  expect(usableModel(options, ref)).toEqual(ref);
  expect(usableModel(options, { ...ref, model: "gemini-2.5-pro" })).toBeUndefined();
  expect(usableModel(options, undefined)).toBeUndefined();
});

test("two refs are the same model when provider and model match; no model equals no model", () => {
  const a = { providerId: "p", model: "m" };
  expect(sameModel(a, { ...a })).toBe(true);
  expect(sameModel(a, { ...a, model: "n" })).toBe(false);
  expect(sameModel(a, undefined)).toBe(false);
  expect(sameModel(undefined, undefined)).toBe(true);
});

test("switching asks only when the session has history and the model really changes", () => {
  const a = { providerId: "p", model: "a" };
  const b = { providerId: "p", model: "b" };
  expect(needsSwitchConfirmation(true, a, b)).toBe(true);
  expect(needsSwitchConfirmation(true, undefined, b)).toBe(true);
  expect(needsSwitchConfirmation(true, a, undefined)).toBe(true);
  expect(needsSwitchConfirmation(false, a, b)).toBe(false);
  expect(needsSwitchConfirmation(true, a, { ...a })).toBe(false);
  expect(needsSwitchConfirmation(true, undefined, undefined)).toBe(false);
});

test("a message box shows the user's pick for this chat, else the task default while it is usable", () => {
  const options = modelOptions([express]);
  const def = { providerId: express.providerId, model: "gemini-2.5-flash" };
  const other = { providerId: express.providerId, model: "gemini-2.5-pro" };
  expect(pickedModel(null, "t1", options, def)).toEqual(def);
  expect(pickedModel({ key: "t1", model: undefined }, "t1", options, def)).toBeUndefined();
  expect(pickedModel({ key: "t2", model: other }, "t1", options, def)).toEqual(def);
  expect(pickedModel({ key: "t1", model: other }, "t1", options, def)).toEqual(other);
  expect(pickedModel(null, "t1", options, other)).toBeUndefined();
  expect(pickedModel(null, "t1", [], def)).toBeUndefined();
});
