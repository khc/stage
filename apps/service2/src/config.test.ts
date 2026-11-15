import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("defaults to loopback on port 3001", () => {
    expect(loadConfig({})).toEqual({ PORT: 3001, HOST: "127.0.0.1" });
  });

  test("treats undefined values as missing", () => {
    expect(loadConfig({ PORT: undefined, HOST: undefined })).toEqual({
      PORT: 3001,
      HOST: "127.0.0.1",
    });
  });

  test("coerces PORT to a number and takes HOST as given", () => {
    expect(loadConfig({ PORT: "4000", HOST: "0.0.0.0" })).toEqual({ PORT: 4000, HOST: "0.0.0.0" });
  });

  test.each(["abc", "", "0", "30.5", "99999"])("rejects PORT=%p", (PORT) => {
    expect(() => loadConfig({ PORT })).toThrow();
  });

  test("rejects an empty HOST", () => {
    expect(() => loadConfig({ HOST: "" })).toThrow();
  });
});
