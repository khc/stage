import { expect, mock, test } from "bun:test";
import type { RunAgent } from "../agent";
import { createApp } from "./app";
import type { RunJob } from "./jobs";

const noJob: RunJob = async () => "";
const appWith = (run: RunAgent) => createApp(run, noJob);

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("GET /health returns ok", async () => {
  const res = await appWith(mock(async () => "")).request("/health");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("POST /chat returns the agent reply", async () => {
  const run = mock(async (message: string) => `echo: ${message}`);
  const res = await appWith(run).request("/chat", post({ message: "hi" }));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reply: "echo: hi" });
  expect(run).toHaveBeenCalledWith("hi");
});

test("POST /chat returns 502 when the agent run fails", async () => {
  const run = mock(async () => {
    throw new Error("boom");
  });
  const res = await appWith(run).request("/chat", post({ message: "hi" }));

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "agent_error" });
});

test("POST /chat returns 400 for a malformed JSON body", async () => {
  const run = mock(async () => "");
  const res = await appWith(run).request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });

  expect(res.status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

test("POST /chat rejects a missing or empty message", async () => {
  const run = mock(async () => "");
  const app = appWith(run);

  expect((await app.request("/chat", post({}))).status).toBe(400);
  expect((await app.request("/chat", post({ message: "" }))).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run starts the job and returns 202", async () => {
  const runJob = mock(async (_job: string) => "op-1");
  const res = await createApp(async () => "", runJob).request(
    "/jobs/my-job/run",
    { method: "POST" },
  );

  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ operation: "op-1" });
  expect(runJob).toHaveBeenCalledWith("my-job", undefined);
});

test("POST /jobs/:name/run passes an optional message to the job", async () => {
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const res = await createApp(async () => "", runJob).request(
    "/jobs/my-job/run",
    post({ message: "hi there" }),
  );

  expect(res.status).toBe(202);
  expect(runJob).toHaveBeenCalledWith("my-job", "hi there");
});

test("POST /jobs/:name/run rejects an empty or non-string message", async () => {
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const app = createApp(async () => "", runJob);

  expect((await app.request("/jobs/my-job/run", post({ message: "" }))).status).toBe(400);
  expect((await app.request("/jobs/my-job/run", post({ message: 5 }))).status).toBe(400);
  expect((await app.request("/jobs/my-job/run", post({ message: "   " }))).status).toBe(400);
  expect(runJob).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run passes the trimmed message", async () => {
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const res = await createApp(async () => "", runJob).request(
    "/jobs/my-job/run",
    post({ message: "  hi  " }),
  );

  expect(res.status).toBe(202);
  expect(runJob).toHaveBeenCalledWith("my-job", "hi");
});

test("POST /jobs/:name/run and /chat reject an oversized message", async () => {
  const run = mock(async (_message: string) => "reply");
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const app = createApp(run, runJob);
  const tooLong = "x".repeat(10_001);

  expect((await app.request("/jobs/my-job/run", post({ message: tooLong }))).status).toBe(400);
  expect((await app.request("/chat", post({ message: tooLong }))).status).toBe(400);
  expect((await app.request("/chat", post({ message: "x".repeat(10_000) }))).status).toBe(200);
  expect(runJob).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run rejects an invalid job name", async () => {
  const runJob = mock(async (_job: string) => "op-1");
  const app = createApp(async () => "", runJob);

  expect((await app.request("/jobs/My_Job/run", { method: "POST" })).status).toBe(400);
  expect((await app.request("/jobs/-bad/run", { method: "POST" })).status).toBe(400);
  expect(runJob).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run returns 502 job_error when the job fails to start", async () => {
  const runJob = mock(async (_job: string): Promise<string> => {
    throw new Error("secret gcp detail");
  });
  const res = await createApp(async () => "", runJob).request(
    "/jobs/my-job/run",
    { method: "POST" },
  );

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "job_error" });
});
