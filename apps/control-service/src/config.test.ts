import { describe, expect, test } from "bun:test";

import { loadConfig, parseAgentServices, parseAllowedJobs } from "./config";

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
    "AGENT_SERVICES",
  ])("rejects an empty %s", (name) => {
    expect(() => loadConfig({ ...gcp, [name]: "" })).toThrow();
  });
});

describe("agent services settings", () => {
  const services = '{"generic-agents":"http://generic-svc:8080"}';

  test("are read as given, a boolean and a number of milliseconds", () => {
    expect(
      loadConfig({
        ...gcp,
        AGENT_SERVICES: services,
        AGENT_SERVICES_ID_TOKEN: "true",
        QUICK_BUDGET_MS: "45000",
      }),
    ).toMatchObject({
      AGENT_SERVICES: services,
      AGENT_SERVICES_ID_TOKEN: true,
      QUICK_BUDGET_MS: 45_000,
    });
  });

  test("are optional", () => {
    const config = loadConfig(gcp);
    expect(config.AGENT_SERVICES).toBeUndefined();
    expect(config.AGENT_SERVICES_ID_TOKEN).toBeUndefined();
    expect(config.QUICK_BUDGET_MS).toBeUndefined();
  });

  test.each(["", "abc", "0", "999", "1500.5", "240001"])(
    "rejects the QUICK_BUDGET_MS %p",
    (value) => {
      expect(() => loadConfig({ ...gcp, QUICK_BUDGET_MS: value })).toThrow();
    },
  );
});

describe("parseAgentServices", () => {
  test("maps job names to service URLs", () => {
    expect(
      parseAgentServices('{"a-agents":"http://a:8080","b-agents":"https://b.run.app"}'),
    ).toEqual({
      "a-agents": "http://a:8080",
      "b-agents": "https://b.run.app",
    });
  });

  test.each([
    "",
    "not json",
    "[]",
    '"x"',
    '{"a":1}',
    '{"a":""}',
    '{"":"http://a"}',
    '{"a":"not a url"}',
    '{"a":"file:///etc/passwd"}',
    '{"a":"ftp://a"}',
  ])("rejects %p", (value) => {
    expect(() => parseAgentServices(value)).toThrow();
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
