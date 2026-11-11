import { expect, mock, test } from "bun:test";
import type { RunAgent } from "../agent";
import { createApp } from "./app";
import type { ListJobs, RunJob } from "./jobs";

const noJob: RunJob = async () => "";
const noJobs: ListJobs = async () => [];
const noCreate = async (prompt: string) => ({
  runId: crypto.randomUUID(),
  prompt,
});
const noRuns = async () => [];
const noRun = async (_runId: string) => undefined;
const appWith = (run: RunAgent) =>
  createApp(run, noJob, noJobs, noCreate, noRuns, noRun);

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
  const res = await createApp(
    async () => "",
    runJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs/my-job/run", { method: "POST" });

  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ operation: "op-1" });
  expect(runJob).toHaveBeenCalledWith("my-job", undefined);
});

test("POST /jobs/:name/run passes an optional message to the job", async () => {
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const res = await createApp(
    async () => "",
    runJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs/my-job/run", post({ message: "hi there" }));

  expect(res.status).toBe(202);
  expect(runJob).toHaveBeenCalledWith("my-job", "hi there");
});

test("POST /jobs/:name/run rejects an empty or non-string message", async () => {
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const app = createApp(
    async () => "",
    runJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  );

  expect(
    (await app.request("/jobs/my-job/run", post({ message: "" }))).status,
  ).toBe(400);
  expect(
    (await app.request("/jobs/my-job/run", post({ message: 5 }))).status,
  ).toBe(400);
  expect(
    (await app.request("/jobs/my-job/run", post({ message: "   " }))).status,
  ).toBe(400);
  expect(runJob).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run passes the trimmed message", async () => {
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const res = await createApp(
    async () => "",
    runJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs/my-job/run", post({ message: "  hi  " }));

  expect(res.status).toBe(202);
  expect(runJob).toHaveBeenCalledWith("my-job", "hi");
});

test("POST /jobs/:name/run and /chat reject an oversized message", async () => {
  const run = mock(async (_message: string) => "reply");
  const runJob = mock(async (_job: string, _message?: string) => "op-1");
  const app = createApp(run, runJob, noJobs, noCreate, noRuns, noRun);
  const tooLong = "x".repeat(10_001);

  expect(
    (await app.request("/jobs/my-job/run", post({ message: tooLong }))).status,
  ).toBe(400);
  expect((await app.request("/chat", post({ message: tooLong }))).status).toBe(
    400,
  );
  expect(
    (await app.request("/chat", post({ message: "x".repeat(10_000) }))).status,
  ).toBe(200);
  expect(runJob).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run rejects an invalid job name", async () => {
  const runJob = mock(async (_job: string) => "op-1");
  const app = createApp(
    async () => "",
    runJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  );

  expect(
    (await app.request("/jobs/My_Job/run", { method: "POST" })).status,
  ).toBe(400);
  expect((await app.request("/jobs/-bad/run", { method: "POST" })).status).toBe(
    400,
  );
  expect(runJob).not.toHaveBeenCalled();
});

test("POST /jobs/:name/run returns 502 job_error when the job fails to start", async () => {
  const runJob = mock(async (_job: string): Promise<string> => {
    throw new Error("secret gcp detail");
  });
  const res = await createApp(
    async () => "",
    runJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs/my-job/run", { method: "POST" });

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "job_error" });
});

test("GET /jobs returns all listed job resources", async () => {
  const jobs = [
    { name: "projects/p/locations/l/jobs/first", labels: { team: "agent" } },
    { name: "projects/p/locations/l/jobs/second" },
  ];
  const listJobs = mock(async () => jobs);
  const res = await createApp(
    async () => "",
    noJob,
    listJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jobs });
  expect(listJobs).toHaveBeenCalledTimes(1);
});

test("GET /jobs returns an empty jobs array", async () => {
  const res = await createApp(
    async () => "",
    noJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jobs: [] });
});

test("GET /jobs returns 502 job_error without upstream details", async () => {
  const listJobs = mock(async (): ReturnType<ListJobs> => {
    throw new Error("secret listing detail");
  });
  const res = await createApp(
    async () => "",
    noJob,
    listJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs");

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "job_error" });
});

const savedRun = {
  runId: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8",
  prompt: "hello",
};
const runApp = () => {
  const agent = mock(async () => "");
  const job = mock(async () => "");
  const create = mock(async (prompt: string) => ({ ...savedRun, prompt }));
  const list = mock(async () => [savedRun]);
  const get = mock(
    async (_id: string) => savedRun as typeof savedRun | undefined,
  );
  return {
    app: createApp(agent, job, noJobs, create, list, get),
    agent,
    job,
    create,
    list,
    get,
  };
};

test("POST /jobs/runs saves a trimmed prompt and returns 201 without executing", async () => {
  const { app, create, agent, job } = runApp();
  const response = await app.request(
    "/jobs/runs",
    post({ prompt: "  hello  ", runId: "client-id", extra: true }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(savedRun);
  expect(create).toHaveBeenCalledWith("hello");
  expect(create).toHaveBeenCalledTimes(1);
  expect(agent).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

test("POST /jobs/runs accepts the maximum prompt length", async () => {
  const { app, create } = runApp();
  expect(
    (await app.request("/jobs/runs", post({ prompt: "x".repeat(10_000) })))
      .status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith("x".repeat(10_000));
});

test("POST /jobs/runs rejects invalid bodies without saving", async () => {
  const { app, create } = runApp();
  for (const body of [
    {},
    { prompt: "" },
    { prompt: "   " },
    { prompt: 42 },
    { prompt: null },
    { prompt: "x".repeat(10_001) },
  ]) {
    expect((await app.request("/jobs/runs", post(body))).status).toBe(400);
  }
  expect(
    (
      await app.request("/jobs/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      })
    ).status,
  ).toBe(400);
  expect((await app.request("/jobs/runs", { method: "POST" })).status).toBe(
    400,
  );
  expect(create).not.toHaveBeenCalled();
});

test("GET /jobs/runs returns a collection without executing or creating", async () => {
  const { app, list, get, create, agent, job } = runApp();
  const response = await app.request("/jobs/runs");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ runs: [savedRun] });
  expect(list).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(agent).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

test("GET /jobs/runs returns an empty collection", async () => {
  const response = await createApp(
    async () => "",
    noJob,
    noJobs,
    noCreate,
    noRuns,
    noRun,
  ).request("/jobs/runs");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ runs: [] });
});

test("GET /jobs/runs/:runId returns a contract and normalizes uppercase UUIDs", async () => {
  const { app, get, create, agent, job, list } = runApp();
  for (const id of [savedRun.runId, savedRun.runId.toUpperCase()]) {
    const response = await app.request(`/jobs/runs/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(savedRun);
    expect(get).toHaveBeenLastCalledWith(savedRun.runId);
  }
  expect(create).not.toHaveBeenCalled();
  expect(agent).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

test("GET /jobs/runs/:runId returns 404 for an absent UUID", async () => {
  const { app, get } = runApp();
  get.mockResolvedValue(undefined);
  const response = await app.request(`/jobs/runs/${savedRun.runId}`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "run_not_found" });
});

test("GET /jobs/runs/:runId rejects an invalid UUID before storage", async () => {
  const { app, get } = runApp();
  expect((await app.request("/jobs/runs/not-a-uuid")).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
});

for (const operation of ["create", "list", "get"] as const) {
  test(`${operation} run failures return 502 without private storage details`, async () => {
    const fixtures = runApp();
    fixtures[operation].mockRejectedValue(new Error("private storage detail"));
    const response = await fixtures.app.request(
      operation === "get" ? `/jobs/runs/${savedRun.runId}` : "/jobs/runs",
      operation === "create" ? post({ prompt: "hello" }) : undefined,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "run_error" });
  });
}
