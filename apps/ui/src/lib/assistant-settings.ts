import { useState } from "react";

import type { ModelRef, RunMode } from "./api";

// Preferences for the assistant, kept per browser. A new chat starts with `defaultTarget` (the agent),
// `runMode` and `defaultModel`.
export type AssistantSettings = {
  runMode: RunMode;
  defaultTarget?: { jobName: string; agentName?: string };
  defaultModel?: ModelRef;
};

export const assistantSettingsKey = "stage.assistant-settings";
export const defaultAssistantSettings: AssistantSettings = { runMode: "workflow" };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// Anything that is not a well-formed value falls back to the default, so stale or edited storage is harmless.
export const parseAssistantSettings = (raw: string | null): AssistantSettings => {
  try {
    const value = JSON.parse(raw ?? "null") as {
      runMode?: unknown;
      defaultTarget?: { jobName?: unknown; agentName?: unknown };
      defaultModel?: { providerId?: unknown; model?: unknown };
    } | null;
    const target = value?.defaultTarget;
    const model = value?.defaultModel;
    return {
      runMode: value?.runMode === "quick" ? "quick" : "workflow",
      ...(isText(target?.jobName) && {
        defaultTarget: {
          jobName: target.jobName,
          ...(isText(target.agentName) && { agentName: target.agentName }),
        },
      }),
      ...(isText(model?.providerId) &&
        isText(model.model) && {
          defaultModel: { providerId: model.providerId, model: model.model },
        }),
    };
  } catch {
    return defaultAssistantSettings;
  }
};

// Equal in value, whatever the order the keys were built in.
export const sameAssistantSettings = (a: AssistantSettings, b: AssistantSettings) =>
  a.runMode === b.runMode &&
  a.defaultTarget?.jobName === b.defaultTarget?.jobName &&
  a.defaultTarget?.agentName === b.defaultTarget?.agentName &&
  a.defaultModel?.providerId === b.defaultModel?.providerId &&
  a.defaultModel?.model === b.defaultModel?.model;

// Storage can be missing or throw (private windows, blocked site data); the page works without it.
export const readAssistantSettings = (): AssistantSettings => {
  try {
    return parseAssistantSettings(localStorage.getItem(assistantSettingsKey));
  } catch {
    return defaultAssistantSettings;
  }
};

export const writeAssistantSettings = (settings: AssistantSettings) => {
  try {
    localStorage.setItem(assistantSettingsKey, JSON.stringify(settings));
  } catch {
    // The choice then lasts only until the page reloads.
  }
};

export function useAssistantSettings() {
  const [settings, setSettings] = useState(readAssistantSettings);
  const save = (next: AssistantSettings) => {
    setSettings(next);
    writeAssistantSettings(next);
  };
  return [settings, save] as const;
}
