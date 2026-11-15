import { describe, expect, spyOn, test } from "bun:test";

import { createApp } from "./app";
import { MAX_EXTRACT_BYTES } from "./modules/extractions/extractions-model";
import type { ExtractionsService } from "./modules/extractions/extractions-service";
import type { Extraction } from "./platform/xberg-client";

const extraction: Extraction = { mimeType: "text/plain", content: "hi", pages: [] };
const appWith = (extractionsService: Partial<ExtractionsService> = {}) =>
  createApp({
    healthService: { check: () => ({ ok: true }) },
    extractionsService: {
      extract: async () => ({ status: "extracted", extraction }),
      ...extractionsService,
    },
  });
const handle = (app: ReturnType<typeof appWith>, path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));
const upload = (form: FormData, headers?: Record<string, string>) => ({
  method: "POST",
  body: form,
  headers,
});
const withFile = (name = "a.txt", type = "text/plain") => {
  const form = new FormData();
  form.set("file", new File(["hi"], name, { type }));
  return form;
};

describe("request ids", () => {
  test("every response carries x-request-id: the caller's, or a generated one", async () => {
    const generated = await handle(appWith(), "/health");
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await handle(appWith(), "/health", { headers: { "x-request-id": "trace-1" } });
    expect(kept.headers.get("x-request-id")).toBe("trace-1");
    const failed = await handle(appWith(), "/extract", { method: "POST" });
    expect(failed.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /health", () => {
  test("answers ok", async () => {
    const res = await handle(appWith(), "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /extract", () => {
  test("returns the extraction of the uploaded file", async () => {
    let seen: File | undefined;
    const app = appWith({
      extract: async (file) => ((seen = file), { status: "extracted", extraction }),
    });
    const res = await handle(app, "/extract", upload(withFile()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(extraction);
    expect(seen?.name).toBe("a.txt");
  });

  test("400 when the file is missing", async () => {
    const res = await handle(appWith(), "/extract", upload(new FormData()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "multipart field 'file' is required" });
  });

  test("400 when the body is JSON without a file", async () => {
    const res = await handle(appWith(), "/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "not a file" }),
    });
    expect(res.status).toBe(400);
  });

  test("400 for a multipart body that cannot be read", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(appWith(), "/extract", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "not multipart",
    });
    spy.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  test("422 with the parser's message when extraction fails", async () => {
    const app = appWith({
      extract: async () => ({ status: "extraction_failed", message: "boom" }),
    });
    const res = await handle(app, "/extract", upload(withFile()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "boom" });
  });

  test("413 for an upload that declares more than 50 MiB, without reading it", async () => {
    let called = false;
    const app = appWith({
      extract: async () => ((called = true), { status: "extracted", extraction }),
    });
    const res = await handle(
      app,
      "/extract",
      upload(withFile(), { "content-length": String(MAX_EXTRACT_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "file too large" });
    expect(called).toBe(false);
  });

  test("an unexpected error is a 500 internal_error, not a leak", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const app = appWith({
      extract: async () => {
        throw new Error("secret detail");
      },
    });
    const res = await handle(app, "/extract", upload(withFile()));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  test("an unknown route is a 404", async () => {
    expect((await handle(appWith(), "/nope")).status).toBe(404);
  });
});
