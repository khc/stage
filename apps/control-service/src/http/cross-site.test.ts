import { describe, expect, test } from "bun:test";

import { Elysia } from "elysia";

import { rejectCrossSite } from "./cross-site";

const app = new Elysia()
  .use(rejectCrossSite())
  .get("/read", () => "ok")
  .post("/write", () => "ok");
const send = async (method: string, path: string, site?: string) => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: site ? { "sec-fetch-site": site } : {},
    }),
  );
  return res.status;
};

describe("rejectCrossSite", () => {
  test("refuses a cross-site POST", async () => {
    expect(await send("POST", "/write", "cross-site")).toBe(403);
  });

  test.each([undefined, "same-origin", "same-site", "none"])(
    "lets a POST with Sec-Fetch-Site %s through",
    async (site) => {
      expect(await send("POST", "/write", site)).toBe(200);
    },
  );

  test("lets a cross-site GET through", async () => {
    expect(await send("GET", "/read", "cross-site")).toBe(200);
  });
});
