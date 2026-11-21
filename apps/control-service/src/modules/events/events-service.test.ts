import { expect, mock, test } from "bun:test";

import { DependencyError } from "../../errors";
import type { PlatformEventStream } from "../../platform/platform-event-stream";
import type { StreamListener } from "../../platform/session-event-stream";
import { createEventsService } from "./events-service";

test("delivers the events the stream pushes, each id once, and unsubscribes on abort", async () => {
  const listeners: StreamListener[] = [];
  const unsubscribe = mock(() => {});
  const stream: PlatformEventStream = async (listener) => {
    listeners.push(listener);
    return unsubscribe;
  };
  const controller = new AbortController();
  const entries = await createEventsService({ platformEventStream: stream }).stream({
    signal: controller.signal,
    idleMs: 60_000,
  });
  listeners[0]!("a", "1");
  listeners[0]!("a", "again");
  listeners[0]!("b", "2");
  const iterator = entries[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ id: "a", data: "1" });
  expect((await iterator.next()).value).toEqual({ id: "b", data: "2" });
  controller.abort();
  expect((await iterator.next()).done).toBe(true);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("a stream that cannot be subscribed is an events_error", async () => {
  const stream: PlatformEventStream = async () => {
    throw new Error("pubsub down");
  };
  const err = await createEventsService({ platformEventStream: stream })
    .stream({ signal: new AbortController().signal, idleMs: 10 })
    .then(
      () => undefined,
      (e) => e,
    );
  expect(err).toBeInstanceOf(DependencyError);
  expect((err as DependencyError).code).toBe("events_error");
});
