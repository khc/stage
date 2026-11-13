import { afterEach, expect, mock, test } from "bun:test";

import { invalidationsFor, isLive, pollUnlessLive, startPlatformEvents } from "./platform-events";

test("maps each platform event to the queries it affects", () => {
  expect(invalidationsFor({ type: "task.created", taskId: "t1" })).toEqual([
    ["tasks"],
    ["task", "t1"],
  ]);
  expect(invalidationsFor({ type: "task.deleted", taskId: "t1" })).toEqual([
    ["tasks"],
    ["task", "t1"],
  ]);
  expect(invalidationsFor({ type: "task.run_requested", taskId: "t1" })).toEqual([
    ["tasks"],
    ["sessions", "t1"],
  ]);
  expect(invalidationsFor({ type: "document.added", taskId: "t1" })).toEqual([
    ["documents", "t1"],
    ["task", "t1"],
  ]);
  expect(invalidationsFor({ type: "job.registration_requested", jobName: "j" })).toEqual([
    ["agents", "j"],
  ]);
});

test("ignores unknown events and events missing their id", () => {
  expect(invalidationsFor({ type: "other" })).toEqual([]);
  expect(invalidationsFor({ type: "task.created" })).toEqual([["tasks"]]);
  expect(invalidationsFor({ type: "document.added" })).toEqual([]);
  expect(invalidationsFor({ type: "job.registration_requested" })).toEqual([]);
});

type Handler = (m?: { data: string }) => void;
const instances: FakeSource[] = [];
class FakeSource {
  handlers: Record<string, Handler> = {};
  close = mock(() => {});
  constructor(public url: string) {
    instances.push(this);
  }
  addEventListener(type: string, handler: Handler) {
    this.handlers[type] = handler;
  }
}
const original = globalThis.EventSource;
afterEach(() => {
  globalThis.EventSource = original;
  instances.length = 0;
});

const start = () => {
  globalThis.EventSource = FakeSource as never;
  const invalidateQueries = mock((_filters?: unknown) => Promise.resolve());
  const stop = startPlatformEvents({ invalidateQueries } as never);
  return { invalidateQueries, stop, source: instances[0]! };
};

test("goes live on open, refreshes everything, then refreshes per event", () => {
  const { invalidateQueries, source } = start();
  expect(source.url).toBe("/events");
  expect(pollUnlessLive()).toBe(15_000);

  source.handlers.open!();
  expect(isLive()).toBe(true);
  expect(pollUnlessLive()).toBe(false);
  expect(invalidateQueries).toHaveBeenLastCalledWith();

  source.handlers.message!({ data: JSON.stringify({ type: "task.created", taskId: "t1" }) });
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["tasks"] });
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["task", "t1"] });
});

test("refreshes everything on error so observers recompute their polling interval", () => {
  const { invalidateQueries, source } = start();
  source.handlers.open!();
  invalidateQueries.mockClear();

  source.handlers.error!();

  expect(isLive()).toBe(false);
  expect(invalidateQueries).toHaveBeenCalledTimes(1);
  expect(invalidateQueries).toHaveBeenLastCalledWith();
});

test("falls back to polling on error, ignores bad data and closes on stop", () => {
  const { invalidateQueries, stop, source } = start();
  source.handlers.open!();
  const calls = invalidateQueries.mock.calls.length;

  source.handlers.message!({ data: "not json" });
  expect(invalidateQueries.mock.calls.length).toBe(calls);

  source.handlers.error!();
  expect(isLive()).toBe(false);
  expect(pollUnlessLive()).toBe(15_000);

  source.handlers.open!();
  stop();
  expect(source.close).toHaveBeenCalled();
  expect(isLive()).toBe(false);
});
