import { expect, test } from "bun:test";

import { createApp } from "./app";
import type { Extraction } from "./extract";

const result: Extraction = { mimeType: "text/plain", content: "hi", pages: [] };
const app = createApp(async () => result);

const upload = (form: FormData) => app.request("/extract", { method: "POST", body: form });

test("returns extraction for uploaded file", async () => {
  const form = new FormData();
  form.set("file", new File(["hi"], "a.txt", { type: "text/plain" }));
  const res = await upload(form);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(result);
});

test("400 when file is missing", async () => {
  const res = await upload(new FormData());
  expect(res.status).toBe(400);
});

test("422 when extraction fails", async () => {
  const failing = createApp(async () => {
    throw new Error("boom");
  });
  const form = new FormData();
  form.set("file", new File(["x"], "a.txt"));
  const res = await failing.request("/extract", { method: "POST", body: form });
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ error: "boom" });
});
