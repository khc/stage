import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { main } from "./main";

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

test("runs the agent with AGENT_MESSAGE, prints the reply and returns 0", async () => {
  const run = mock(async (_message: string) => "hello");

  expect(await main({ AGENT_MESSAGE: "hi" }, run)).toBe(0);
  expect(run).toHaveBeenCalledWith("hi");
  expect(log).toHaveBeenCalledWith("hello");
});

test("returns 1 when AGENT_MESSAGE is missing", async () => {
  const run = mock(async (_message: string) => "hello");

  expect(await main({}, run)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("AGENT_MESSAGE is required");
});

test("returns 1 when AGENT_MESSAGE is only whitespace", async () => {
  const run = mock(async (_message: string) => "hello");

  expect(await main({ AGENT_MESSAGE: "   " }, run)).toBe(1);
  expect(run).not.toHaveBeenCalled();
});

test("returns 1 and logs the error when the run fails", async () => {
  const failure = new Error("boom");
  const run = mock(async (_message: string): Promise<string> => {
    throw failure;
  });

  expect(await main({ AGENT_MESSAGE: "hi" }, run)).toBe(1);
  expect(error).toHaveBeenCalledWith(failure);
});
