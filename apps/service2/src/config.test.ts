import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("defaults PORT to 3001", () => {
    expect(loadConfig({})).toEqual({ PORT: 3001 });
  });

  test("treats an undefined PORT as missing", () => {
    expect(loadConfig({ PORT: undefined })).toEqual({ PORT: 3001 });
  });

  test("coerces PORT to a number", () => {
    expect(loadConfig({ PORT: "4000" })).toEqual({ PORT: 4000 });
  });

  test.each(["abc", "", "0", "30.5", "99999"])("rejects PORT=%p", (PORT) => {
    expect(() => loadConfig({ PORT })).toThrow();
  });
});
