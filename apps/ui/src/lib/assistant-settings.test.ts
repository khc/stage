import { expect, test } from "bun:test";

import {
  defaultAssistantSettings,
  parseAssistantSettings,
  readAssistantSettings,
  sameAssistantSettings,
  writeAssistantSettings,
} from "./assistant-settings";

test("parseAssistantSettings keeps valid values and falls back to the defaults", () => {
  expect(parseAssistantSettings(null)).toEqual(defaultAssistantSettings);
  expect(parseAssistantSettings("not json")).toEqual(defaultAssistantSettings);
  expect(parseAssistantSettings('{"runMode":"bogus","defaultTarget":{"jobName":3}}')).toEqual(
    defaultAssistantSettings,
  );
  expect(
    parseAssistantSettings(
      '{"runMode":"quick","defaultTarget":{"jobName":"job-a","agentName":"poet"}}',
    ),
  ).toEqual({ runMode: "quick", defaultTarget: { jobName: "job-a", agentName: "poet" } });
  expect(parseAssistantSettings('{"runMode":"quick","defaultTarget":{"jobName":"job-a"}}')).toEqual(
    {
      runMode: "quick",
      defaultTarget: { jobName: "job-a" },
    },
  );
});

test("read and write survive storage that is missing or throws", () => {
  expect(readAssistantSettings()).toEqual(defaultAssistantSettings);
  expect(() => writeAssistantSettings({ runMode: "quick" })).not.toThrow();
});

test("parseAssistantSettings keeps a well-formed default model and drops a broken one", () => {
  const model = { providerId: "p1", model: "flash" };
  expect(
    parseAssistantSettings(JSON.stringify({ runMode: "workflow", defaultModel: model })),
  ).toEqual({
    runMode: "workflow",
    defaultModel: model,
  });
  expect(
    parseAssistantSettings('{"runMode":"workflow","defaultModel":{"providerId":"p1"}}'),
  ).toEqual(defaultAssistantSettings);
});

test("sameAssistantSettings compares values, not key order", () => {
  const a = { runMode: "quick", defaultModel: { providerId: "p", model: "m" } } as const;
  const b = { defaultModel: { model: "m", providerId: "p" }, runMode: "quick" } as const;
  expect(sameAssistantSettings(a, b)).toBe(true);
  expect(sameAssistantSettings(a, { ...b, runMode: "workflow" })).toBe(false);
  expect(sameAssistantSettings(a, { runMode: "quick" })).toBe(false);
  expect(
    sameAssistantSettings(
      { runMode: "quick", defaultTarget: { jobName: "j" } },
      { runMode: "quick", defaultTarget: { jobName: "j", agentName: "a" } },
    ),
  ).toBe(false);
});
