import { expect, test } from "bun:test";

import { loadConfig } from "./config";

test("listens on loopback on port 8080 unless told otherwise", () => {
  expect(loadConfig({})).toEqual({ PORT: 8080, HOST: "127.0.0.1" });
  expect(loadConfig({ PORT: "9000", HOST: "0.0.0.0" })).toEqual({ PORT: 9000, HOST: "0.0.0.0" });
});
