import { describe, expect, mock, test } from "bun:test";

import { DependencyError } from "../../../errors";
import type { SessionEventStream, StreamListener } from "../../../platform/session-event-stream";
import type { FeedEntry } from "../../../utils/event-feed";
import { createSessionsService } from "./sessions-service";
import type { SessionsStore } from "./sessions-store";

const stored = [
  { id: "e1", author: "a" },
  { id: "e2", author: "a" },
];
const options = (controller = new AbortController()) => ({
  controller,
  signal: controller.signal,
  idleMs: 20,
});

const setup = (opts: { session?: boolean; stream?: boolean } = {}) => {
  const calls: string[] = [];
  const listeners: StreamListener[] = [];
  const unsubscribe = mock(() => {});
  const sessionEventStream: SessionEventStream = async (_t, _s, listener) => {
    calls.push("subscribe");
    listeners.push(listener);
    return unsubscribe;
  };
  const get = mock(async (_t: string, _s: string) => {
    calls.push("read");
    return opts.session === false ? undefined : ({ id: "s1", events: stored } as never);
  });
  const service = createSessionsService({
    sessionsStore: { get } as unknown as SessionsStore,
    sessionEventStream: opts.stream === false ? undefined : sessionEventStream,
  });
  return { service, calls, listeners, unsubscribe, get };
};

// Reads a fixed number of entries without closing the sequence.
const take = async (entries: AsyncIterable<FeedEntry>, count: number) => {
  const iterator = entries[Symbol.asyncIterator]();
  const out: FeedEntry[] = [];
  for (let i = 0; i < count; i++) out.push((await iterator.next()).value as FeedEntry);
  return out;
};

describe("sessions service messages", () => {
  test("a missing session is reported and its subscription is dropped again", async () => {
    const { service, unsubscribe } = setup({ session: false });
    expect(await service.messages("t", "s1", options())).toEqual({ status: "session_not_found" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("subscribes before reading the history, so no event falls in the gap", async () => {
    const { service, calls } = setup();
    await service.messages("t", "s1", options());
    expect(calls).toEqual(["subscribe", "read"]);
  });

  test("replays the stored events first, then live ones, each id once", async () => {
    const { service, listeners } = setup();
    const result = await service.messages("t", "s1", options());
    if (result.status !== "ok") throw new Error("expected a stream");
    // An event that arrives while the history is read is also in the history.
    listeners[0]!("e2", JSON.stringify({ id: "e2", author: "a" }));
    listeners[0]!("e3", JSON.stringify({ id: "e3", author: "b" }));
    const ids = (await take(result.entries, 3)).map((e) => (e as { id: string }).id);
    expect(ids).toEqual(["e1", "e2", "e3"]);
  });

  test("without a live source it still serves the stored events, then reports idle", async () => {
    const { service } = setup({ stream: false });
    const result = await service.messages("t", "s1", options());
    if (result.status !== "ok") throw new Error("expected a stream");
    const entries = await take(result.entries, 3);
    expect(entries.slice(0, 2).map((e) => (e as { id: string }).id)).toEqual(["e1", "e2"]);
    expect(entries[2]).toBe("idle");
  });

  test("aborting the signal ends the sequence and unsubscribes", async () => {
    const { service, unsubscribe } = setup();
    const { controller, signal } = options();
    const result = await service.messages("t", "s1", { signal, idleMs: 60_000 });
    if (result.status !== "ok") throw new Error("expected a stream");
    const done = (async () => {
      const iterator = result.entries[Symbol.asyncIterator]();
      let next = await iterator.next();
      while (!next.done) next = await iterator.next();
      return "ended";
    })();
    await Bun.sleep(5);
    controller.abort();
    expect(await done).toBe("ended");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("a failure while reading is an events_error and drops the subscription", async () => {
    const { service, get, unsubscribe } = setup();
    get.mockRejectedValue(new Error("firestore down"));
    const err = await service.messages("t", "s1", options()).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe("events_error");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("sessions service stats", () => {
  test("sums the model usage of the session's events", async () => {
    const service = createSessionsService({
      sessionsStore: {
        get: async () => ({
          events: [{ usageMetadata: { promptTokenCount: 3, totalTokenCount: 5 } }, {}],
        }),
      } as unknown as SessionsStore,
    });
    expect(await service.stats("t", "s1")).toMatchObject({
      events: 2,
      llmCalls: 1,
      tokens: { prompt: 3, total: 5 },
    });
  });

  test("is undefined for a missing session", async () => {
    const service = createSessionsService({
      sessionsStore: { get: async () => undefined } as unknown as SessionsStore,
    });
    expect(await service.stats("t", "nope")).toBeUndefined();
  });
});
