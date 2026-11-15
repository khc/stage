import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config";

const gcp = { GCP_PROJECT: "floci-local", GCP_REGION: "us-central1" };

describe("loadConfig", () => {
  test("defaults to loopback on port 3000, and EXTRACT_URL is optional", () => {
    expect(loadConfig(gcp)).toEqual({ ...gcp, PORT: 3000, HOST: "127.0.0.1" });
  });

  test("treats undefined values as missing", () => {
    expect(
      loadConfig({
        ...gcp,
        PORT: undefined,
        HOST: undefined,
        EXTRACT_URL: undefined,
        PUBSUB_TOPIC: undefined,
      }),
    ).toEqual({
      ...gcp,
      PORT: 3000,
      HOST: "127.0.0.1",
    });
  });

  test("coerces PORT to a number and takes HOST and EXTRACT_URL as given", () => {
    expect(
      loadConfig({
        ...gcp,
        PORT: "4000",
        HOST: "0.0.0.0",
        EXTRACT_URL: "http://extract:8080",
        PUBSUB_TOPIC: "agent-events",
      }),
    ).toEqual({
      ...gcp,
      PORT: 4000,
      HOST: "0.0.0.0",
      EXTRACT_URL: "http://extract:8080",
      PUBSUB_TOPIC: "agent-events",
    });
  });

  test.each(["abc", "", "0", "30.5", "99999"])("rejects PORT=%p", (PORT) => {
    expect(() => loadConfig({ ...gcp, PORT })).toThrow();
  });

  test("rejects an empty HOST", () => {
    expect(() => loadConfig({ ...gcp, HOST: "" })).toThrow();
  });

  test.each(["GCP_PROJECT", "GCP_REGION"])("requires %s", (name) => {
    expect(() => loadConfig({ ...gcp, [name]: undefined })).toThrow();
  });
});
