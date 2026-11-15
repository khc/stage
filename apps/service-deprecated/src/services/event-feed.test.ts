import { expect, test } from "bun:test";

import { createEventFeed, type FeedEntry } from "./event-feed";

// Reads a fixed number of entries without closing the sequence.
const take = async (entries: AsyncIterable<FeedEntry>, count: number) => {
  const iterator = entries[Symbol.asyncIterator]();
  const out: FeedEntry[] = [];
  for (let i = 0; i < count; i++) out.push((await iterator.next()).value as FeedEntry);
  return out;
};

test("delivers pushed events in order, once per id", async () => {
  const feed = createEventFeed({ signal: new AbortController().signal, idleMs: 1_000 });
  feed.push("a", "1");
  feed.push("b", "2");
  feed.push("a", "again");
  feed.push("c", "3");
  expect(await take(feed.entries, 3)).toEqual([
    { id: "a", data: "1" },
    { id: "b", data: "2" },
    { id: "c", data: "3" },
  ]);
});

test("prepended events come first and later duplicates of them are dropped", async () => {
  const feed = createEventFeed({ signal: new AbortController().signal, idleMs: 1_000 });
  feed.push("live-1", "L1");
  feed.push("old-2", "live copy");
  feed.prepend([
    { id: "old-1", data: "O1" },
    { id: "old-2", data: "O2" },
  ]);
  expect((await take(feed.entries, 3)).map((e) => (e as { id: string }).id)).toEqual([
    "old-1",
    "old-2",
    "live-1",
  ]);
});

test("an event pushed while waiting wakes the sequence", async () => {
  const feed = createEventFeed({ signal: new AbortController().signal, idleMs: 5_000 });
  const first = take(feed.entries, 1);
  await Bun.sleep(5);
  feed.push("a", "1");
  expect(await first).toEqual([{ id: "a", data: "1" }]);
});

test("reports idle when nothing arrives within the interval", async () => {
  const feed = createEventFeed({ signal: new AbortController().signal, idleMs: 10 });
  expect(await take(feed.entries, 2)).toEqual(["idle", "idle"]);
});

test("ends when the signal aborts, even while waiting", async () => {
  const controller = new AbortController();
  const feed = createEventFeed({ signal: controller.signal, idleMs: 60_000 });
  const done = (async () => {
    let result = await feed.entries.next();
    while (!result.done) result = await feed.entries.next();
    return "ended";
  })();
  await Bun.sleep(5);
  controller.abort();
  expect(await done).toBe("ended");
});

test("with a seen limit, only the latest ids are remembered", async () => {
  const feed = createEventFeed({
    signal: new AbortController().signal,
    idleMs: 1_000,
    seenLimit: 2,
  });
  for (const id of ["a", "b", "c"]) feed.push(id, id);
  await take(feed.entries, 3);
  feed.push("a", "a again");
  feed.push("c", "c again");
  const next = await take(feed.entries, 1);
  expect(next).toEqual([{ id: "a", data: "a again" }]);
});

test("ends when the signal aborts while the consumer is busy with an entry", async () => {
  const controller = new AbortController();
  const feed = createEventFeed({ signal: controller.signal, idleMs: 60_000 });
  feed.push("a", "1");
  const iterator = feed.entries[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ id: "a", data: "1" });
  controller.abort();
  expect((await iterator.next()).done).toBe(true);
});
