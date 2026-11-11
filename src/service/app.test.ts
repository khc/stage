import { expect, mock, test } from "bun:test";
import type { CreateRun, RunContract } from "./runs";
import type { RunAgent } from "../agent";
import { createApp } from "./app";
import type { ListJobs, RunJob } from "./jobs";

const noJob: RunJob = async () => "";
const noJobs: ListJobs = async () => [];
const noCreate: CreateRun = async (input) => ({
  runId: crypto.randomUUID(),
  ...input,
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

test("POST /chat validates its maximum message length", async () => {
  const run = mock(async () => "reply");
  const app = appWith(run);
  expect(
    (await app.request("/chat", post({ message: "x".repeat(10_001) }))).status,
  ).toBe(400);
  expect(run).not.toHaveBeenCalled();
  expect(
    (await app.request("/chat", post({ message: "x".repeat(10_000) }))).status,
  ).toBe(200);
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
  jobName: "my-job",
};
const runApp = () => {
  const agent = mock(async () => "");
  const job = mock(async (_jobName: string, _runId: string) => "op-1");
  const create = mock(async (input: { prompt: string; jobName: string }) => ({
    ...savedRun,
    ...input,
  }));
  const list = mock(async () => [savedRun]);
  const get = mock(async (_id: string) => savedRun as RunContract | undefined);
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
    post({
      jobName: "my-job",
      prompt: "  hello  ",
      runId: "client-id",
      extra: true,
    }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(savedRun);
  expect(create).toHaveBeenCalledWith({ prompt: "hello", jobName: "my-job" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(agent).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

test("POST /jobs/runs accepts the maximum prompt length", async () => {
  const { app, create } = runApp();
  expect(
    (
      await app.request(
        "/jobs/runs",
        post({ jobName: "my-job", prompt: "x".repeat(10_000) }),
      )
    ).status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith({
    prompt: "x".repeat(10_000),
    jobName: "my-job",
  });
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
    expect(
      (await app.request("/jobs/runs", post({ jobName: "my-job", ...body })))
        .status,
    ).toBe(400);
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
      operation === "create"
        ? post({ jobName: "my-job", prompt: "hello" })
        : undefined,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "run_error" });
  });
}

for (const jobName of [
  undefined,
  42,
  "",
  "My_Job",
  "-bad",
  "bad-",
  "a".repeat(64),
  "projects/p/locations/l/jobs/job",
  " my-job ",
]) {
  test(`creation rejects invalid jobName ${String(jobName)}`, async () => {
    const { app, create } = runApp();
    expect(
      (await app.request("/jobs/runs", post({ prompt: "hello", jobName })))
        .status,
    ).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
}

test("creation accepts a 63-character job name", async () => {
  const { app, create } = runApp();
  const jobName = "a".repeat(63);
  expect(
    (await app.request("/jobs/runs", post({ prompt: "hello", jobName })))
      .status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith({ prompt: "hello", jobName });
});

const execPath = `/jobs/runs/${savedRun.runId}/exec`;
test("exec reads the contract before submitting only stored jobName and normalized UUID", async () => {
  const { app, get, job, agent, create } = runApp();
  const deferred = Promise.withResolvers<RunContract>();
  get.mockImplementation(() => deferred.promise);
  const pending = app.request(
    `/jobs/runs/${savedRun.runId.toUpperCase()}/exec`,
    { method: "POST" },
  );
  await Promise.resolve();
  expect(job).not.toHaveBeenCalled();
  deferred.resolve(savedRun);
  const response = await pending;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ operation: "op-1" });
  expect(get).toHaveBeenCalledWith(savedRun.runId);
  expect(job).toHaveBeenCalledWith("my-job", savedRun.runId);
  expect(agent).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

test("exec ignores conflicting prompt/message/jobName supplied in its body", async () => {
  const { app, job } = runApp();
  const response = await app.request(
    execPath,
    post({ jobName: "different-job", prompt: "override", message: "override" }),
  );
  expect(response.status).toBe(202);
  expect(job).toHaveBeenCalledWith("my-job", savedRun.runId);
});

test("exec rejects invalid UUIDs without reading or submitting", async () => {
  const { app, get, job } = runApp();
  expect(
    (await app.request("/jobs/runs/invalid/exec", { method: "POST" })).status,
  ).toBe(400);
  expect(get).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

test("exec returns 404 for an absent contract without submission", async () => {
  const { app, get, job } = runApp();
  get.mockResolvedValue(undefined);
  const response = await app.request(execPath, { method: "POST" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "run_not_found" });
  expect(job).not.toHaveBeenCalled();
});

for (const jobName of [
  undefined,
  "",
  "Invalid_Name",
  "a".repeat(64),
  "../bad",
  42,
]) {
  test(`exec rejects missing or invalid stored jobName ${String(jobName)}`, async () => {
    const { app, get, job } = runApp();
    get.mockResolvedValue({ ...savedRun, jobName } as RunContract);
    const response = await app.request(execPath, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "run_not_executable" });
    expect(job).not.toHaveBeenCalled();
  });
}

test("exec lookup failure returns run_error without submission", async () => {
  const { app, get, job } = runApp();
  get.mockRejectedValue(new Error("private lookup failure"));
  const response = await app.request(execPath, { method: "POST" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "run_error" });
  expect(job).not.toHaveBeenCalled();
});

test("exec submission failure returns job_error", async () => {
  const { app, job } = runApp();
  job.mockRejectedValue(new Error("private submission failure"));
  const response = await app.request(execPath, { method: "POST" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "job_error" });
});

test("old execution URL is removed", async () => {
  const { app, job, get } = runApp();
  expect(
    (await app.request("/jobs/my-job/run", { method: "POST" })).status,
  ).toBe(404);
  expect(job).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
