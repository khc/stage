import { describe, expect, test } from "bun:test";

import { Elysia, t } from "elysia";

import { requestId, requestIdOf } from "./request-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = new Elysia()
  .use(requestId())
  // Error responses carry the header too, whatever maps them.
  .onError({ as: "global" }, ({ code, status }) =>
    code === "VALIDATION"
      ? status(400, { error: "invalid_request" })
      : code === "NOT_FOUND"
        ? status(404, { error: "not_found" })
        : status(502, { error: "failed" }),
  )
  .get("/ok", ({ request }) => ({ id: requestIdOf(request) }))
  .get("/failure", () => {
    throw new Error("down");
  })
  .get("/valid/:n", ({ params }) => params, { params: t.Object({ n: t.Numeric() }) });

const get = (path: string, id?: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: id ? { "x-request-id": id } : {} }));

describe("request id", () => {
  test("every request gets a generated id in the x-request-id header, and the handler sees it", async () => {
    const res = await get("/ok");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(UUID);
    expect(await res.json()).toEqual({ id });
  });

  test("each request gets its own id", async () => {
    const [a, b] = await Promise.all([get("/ok"), get("/ok")]);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  test("a caller's plain id is kept", async () => {
    expect((await get("/ok", "trace-abc_1.2")).headers.get("x-request-id")).toBe("trace-abc_1.2");
  });

  test.each([
    ["spaces", "has space"],
    ["a semicolon", "a;b"],
    ["too long", "x".repeat(129)],
    ["empty", ""],
  ])("a caller's id with %s is replaced by a generated one", async (_name, bad) => {
    expect((await get("/ok", bad)).headers.get("x-request-id")).toMatch(UUID);
  });

  test.each([
    ["a validation error", "/valid/abc", 400],
    ["an unexpected failure", "/failure", 502],
    ["an unknown route", "/nope", 404],
  ])("the header is on %s", async (_name, path, status) => {
    const res = await get(path, "keep-me");
    expect(res.status).toBe(status);
    expect(res.headers.get("x-request-id")).toBe("keep-me");
  });
});
