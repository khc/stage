import { describe, expect, test } from "bun:test";

import { loadConfig, parseAllowedJobs } from "./config";

const gcp = { GCP_PROJECT: "floci-local", GCP_REGION: "us-central1", AGENT_JOBS: "poet-agents" };

describe("loadConfig", () => {
  test("listens on loopback on port 3000, and the other settings are optional", () => {
    expect(loadConfig(gcp)).toEqual({ ...gcp, PORT: 3000, HOST: "127.0.0.1" });
  });

  test("takes the optional settings as given", () => {
    const optional = {
      EXTRACT_URL: "http://extract:8080",
      EXTRACT_AUDIENCE: "https://extract.run.app",
      PUBSUB_TOPIC: "agent-events",
      PLATFORM_EVENTS_TOPIC: "platform-events",
      SCHEDULER_TARGET_URL: "https://service.run.app",
      SCHEDULER_INVOKER: "stage-scheduler@floci-local.iam.gserviceaccount.com",
      PUBLIC_URL: "http://host.docker.internal:3000",
    };
    expect(loadConfig({ ...gcp, PORT: "4000", HOST: "0.0.0.0", ...optional })).toEqual({
      ...gcp,
      PORT: 4000,
      HOST: "0.0.0.0",
      ...optional,
    });
  });

  test.each(["GCP_PROJECT", "GCP_REGION", "AGENT_JOBS"])("requires %s", (name) => {
    expect(() => loadConfig({ ...gcp, [name]: undefined })).toThrow();
  });

  test.each([
    "EXTRACT_URL",
    "EXTRACT_AUDIENCE",
    "PUBSUB_TOPIC",
    "PLATFORM_EVENTS_TOPIC",
    "SCHEDULER_TARGET_URL",
    "SCHEDULER_INVOKER",
    "PUBLIC_URL",
  ])("rejects an empty %s", (name) => {
    expect(() => loadConfig({ ...gcp, [name]: "" })).toThrow();
  });
});

describe("A2A_TIMEOUT_MS", () => {
  test("is read as a number of milliseconds", () => {
    expect(loadConfig({ ...gcp, A2A_TIMEOUT_MS: "240000" }).A2A_TIMEOUT_MS).toBe(240_000);
  });

  test.each(["", "abc", "500", "1500.5", "250001"])("rejects %p", (value) => {
    expect(() => loadConfig({ ...gcp, A2A_TIMEOUT_MS: value })).toThrow();
  });
});

describe("parseAllowedJobs", () => {
  test("lists the trimmed job names", () => {
    expect(parseAllowedJobs(" poet-agents, generic-agents ,")).toEqual(
      new Set(["poet-agents", "generic-agents"]),
    );
  });

  test("`*` allows every job", () => {
    expect(parseAllowedJobs("*")).toBeUndefined();
  });
});
