import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config";

const gcp = { GCP_PROJECT: "floci-local", GCP_REGION: "us-central1" };

describe("loadConfig", () => {
  test("listens on loopback on port 3000, and every other setting is optional", () => {
    expect(loadConfig(gcp)).toEqual({ ...gcp, PORT: 3000, HOST: "127.0.0.1" });
  });

  test("takes the optional settings as given", () => {
    const optional = {
      EXTRACT_URL: "http://extract:8080",
      EXTRACT_AUDIENCE: "https://extract.run.app",
      PUBSUB_TOPIC: "agent-events",
      PLATFORM_EVENTS_TOPIC: "platform-events",
    };
    expect(loadConfig({ ...gcp, PORT: "4000", HOST: "0.0.0.0", ...optional })).toEqual({
      ...gcp,
      PORT: 4000,
      HOST: "0.0.0.0",
      ...optional,
    });
  });

  test.each(["GCP_PROJECT", "GCP_REGION"])("requires %s", (name) => {
    expect(() => loadConfig({ ...gcp, [name]: undefined })).toThrow();
  });

  test.each(["EXTRACT_URL", "EXTRACT_AUDIENCE", "PUBSUB_TOPIC", "PLATFORM_EVENTS_TOPIC"])(
    "rejects an empty %s",
    (name) => {
      expect(() => loadConfig({ ...gcp, [name]: "" })).toThrow();
    },
  );
});
