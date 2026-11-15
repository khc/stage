import { describe, expect, test } from "bun:test";

import { t } from "elysia";

import { createConfigLoader, serverConfig, serverDefaults } from "./config";

const loadConfig = createConfigLoader(
  { ...serverConfig, NAME: t.String({ minLength: 1 }), OPTIONAL: t.Optional(t.String()) },
  { ...serverDefaults(8080), NAME: "app" },
);

describe("createConfigLoader", () => {
  test("uses the defaults for what is missing: loopback on the given port", () => {
    expect(loadConfig({})).toEqual({ PORT: 8080, HOST: "127.0.0.1", NAME: "app" });
  });

  test("treats undefined values as missing", () => {
    expect(loadConfig({ PORT: undefined, HOST: undefined, OPTIONAL: undefined })).toEqual({
      PORT: 8080,
      HOST: "127.0.0.1",
      NAME: "app",
    });
  });

  test("coerces PORT to a number and takes the other values as given", () => {
    expect(loadConfig({ PORT: "4000", HOST: "0.0.0.0", NAME: "x", OPTIONAL: "y" })).toEqual({
      PORT: 4000,
      HOST: "0.0.0.0",
      NAME: "x",
      OPTIONAL: "y",
    });
  });

  test.each(["abc", "", "0", "30.5", "99999"])("rejects PORT=%p", (PORT) => {
    expect(() => loadConfig({ PORT })).toThrow();
  });

  test("rejects an empty HOST and a value that breaks the app's own schema", () => {
    expect(() => loadConfig({ HOST: "" })).toThrow();
    expect(() => loadConfig({ NAME: "" })).toThrow();
  });

  test("a field without a default is required", () => {
    const strict = createConfigLoader(
      { ...serverConfig, REQUIRED: t.String({ minLength: 1 }) },
      serverDefaults(1),
    );
    expect(() => strict({})).toThrow();
    expect(strict({ REQUIRED: "x" })).toMatchObject({ REQUIRED: "x" });
  });
});
