import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { RunContract } from "../run-contract";
import { main } from "./main";

const runId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
});
const setup = () => ({
  run: mock(async (_prompt: string) => "reply"),
  get: mock(async (_id: string): Promise<RunContract | undefined> => ({
    runId,
    prompt: "  stored prompt  ",
    jobName: "my-job",
  })),
});

test("loads the contract by normalized RUN_ID and runs its exact prompt", async () => {
  const { run, get } = setup();
  expect(
    await main(
      { RUN_ID: runId.toUpperCase(), AGENT_MESSAGE: "ignore this" },
      run,
      get,
    ),
  ).toBe(0);
  expect(get).toHaveBeenCalledWith(runId);
  expect(run).toHaveBeenCalledWith("  stored prompt  ");
  expect(log).toHaveBeenCalledWith("reply");
});

for (const id of [undefined, "", "   ", "invalid-id"]) {
  test(`rejects RUN_ID ${JSON.stringify(id)} before reading or running`, async () => {
    const { run, get } = setup();
    expect(
      await main({ RUN_ID: id, AGENT_MESSAGE: "no fallback" }, run, get),
    ).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
}

test("fails before model execution for an absent contract", async () => {
  const { run, get } = setup();
  get.mockResolvedValue(undefined);
  expect(await main({ RUN_ID: runId }, run, get)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
});

for (const prompt of [undefined, null, 42, "", "   ", "x".repeat(10_001)]) {
  test(`rejects stored prompt ${typeof prompt}:${String(prompt).slice(0, 10)}`, async () => {
    const { run, get } = setup();
    get.mockResolvedValue({ runId, prompt } as RunContract);
    expect(await main({ RUN_ID: runId }, run, get)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
}

test("logs read failures and never invokes the agent", async () => {
  const { run, get } = setup();
  const failure = new Error("read failed");
  get.mockRejectedValue(failure);
  expect(await main({ RUN_ID: runId }, run, get)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(failure);
});

test("logs agent failures and returns 1", async () => {
  const { run, get } = setup();
  const failure = new Error("agent failed");
  run.mockRejectedValue(failure);
  expect(await main({ RUN_ID: runId }, run, get)).toBe(1);
  expect(error).toHaveBeenCalledWith(failure);
});
