import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { Elysia, t } from "elysia";

import { errorHandler, type ErrorHandlerOptions } from "./errors";
import { requestId } from "./request-id";

class DomainError extends Error {}

let logged: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

const appWith = (options?: ErrorHandlerOptions) =>
  new Elysia()
    .use(requestId())
    .use(errorHandler(options))
    .get("/domain", () => {
      throw new DomainError("secret detail");
    })
    .get("/bug", () => {
      throw new Error("secret detail");
    })
    .get("/valid/:n", ({ params }) => params, { params: t.Object({ n: t.Numeric() }) })
    .post("/body", ({ body }) => body, { body: t.Object({ name: t.String() }) })
    .get("/response", () => ({ n: "not a number" }) as unknown as { n: number }, {
      response: t.Object({ n: t.Number() }),
    });

const get = async (app: ReturnType<typeof appWith>, path: string, init?: RequestInit) => {
  const res = await app.handle(new Request(`http://localhost${path}`, init));
  return { res, body: await res.json().catch(() => null) };
};

describe("errorHandler", () => {
  test("an unexpected error is a 500 internal_error that leaks nothing, and is logged with the request id", async () => {
    const { res, body } = await get(appWith(), "/bug");
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "internal_error" });
    const id = res.headers.get("x-request-id");
    expect(logged.mock.calls[0]![0]).toBe(`[${id}]`);
    expect(logged.mock.calls[0]![1]).toBeInstanceOf(Error);
  });

  test("the status of an unexpected error is configurable", async () => {
    expect((await get(appWith({ unexpectedStatus: 502 }), "/bug")).res.status).toBe(502);
  });

  test("an app's own errors are mapped, and what to log is up to the mapper", async () => {
    const app = appWith({
      map: (error) =>
        error instanceof DomainError
          ? { status: 502, body: { error: "domain_error" }, log: "cause only" }
          : undefined,
    });
    const { res, body } = await get(app, "/domain");
    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "domain_error" });
    expect(logged.mock.calls[0]![1]).toBe("cause only");
    // an error the mapper does not know falls through to the default
    expect((await get(app, "/bug")).body).toEqual({ error: "internal_error" });
  });

  test("a validation failure is a 400 that says where and why, without the schema or the value", async () => {
    const { res, body } = await get(appWith(), "/valid/abc");
    expect(res.status).toBe(400);
    expect(body).toEqual({
      error: "invalid_request",
      details: [{ path: "/n", message: expect.any(String) }],
    });
    expect(logged).not.toHaveBeenCalled();
  });

  test("a body that is not JSON is a 400 invalid_request", async () => {
    const { res, body } = await get(appWith(), "/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {",
    });
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid_request" });
  });

  test("a response that breaks its schema is the service's bug, not a bad request", async () => {
    const { res, body } = await get(appWith(), "/response");
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "internal_error" });
    expect(logged).toHaveBeenCalled();
  });

  test("an unknown route is a 404 not_found, and every error carries the request id", async () => {
    const { res, body } = await get(appWith(), "/nope", { headers: { "x-request-id": "keep" } });
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
    expect(res.headers.get("x-request-id")).toBe("keep");
  });
});
