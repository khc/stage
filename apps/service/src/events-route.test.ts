import { expect, mock, test } from "bun:test";

import { createApp } from "./app";
import type { EventListener, LiveEvents } from "./live-events";
import type { TaskContract } from "./tasks";

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";
const url = `/tasks/${taskId}/sessions/s1/messages`;
const stored = [
  { id: "e1", author: "a" },
  { id: "e2", author: "a" },
];

const setup = (opts: { task?: boolean; session?: boolean; live?: LiveEvents }) => {
  const get = mock(async (_t: string, _s: string) =>
    opts.session === false ? undefined : ({ id: "s1", events: stored } as never),
  );
  const app = createApp(
    async () => "",
    async () => [],
    async (i) => ({ taskId, ...i }),
    async () => [],
    async () =>
      opts.task === false ? undefined : ({ taskId, prompt: "p", jobName: "j" } as TaskContract),
    {
      list: async () => [],
      get,
      delete: async () => false,
      queueMessage: async () => true,
      clearMessage: async () => {},
    },
    opts.live,
  );
  return { app, get };
};

const readFrames = async (res: Response, frames: number) => {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length - 1 < frames) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text;
};

test("404 for a missing task or session without subscribing", async () => {
  const live = mock(async () => () => {});
  for (const opts of [{ task: false }, { session: false }] as const) {
    const res = await setup({ ...opts, live }).app.request(url);
    expect(res.status).toBe(404);
  }
  expect(live).toHaveBeenCalledTimes(1);
});

test("without live events it streams the stored events and stays open", async () => {
  const res = await setup({}).app.request(url);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const body = await readFrames(res, 2);
  expect(body).toContain('data: {"id":"e1","author":"a"}\nid: e1');
  expect(body.indexOf("id: e1")).toBeLessThan(body.indexOf("id: e2"));
});

test("replays history then live events, dropping duplicates", async () => {
  let listener: EventListener = () => {};
  const unsubscribe = mock(() => {});
  const live: LiveEvents = async (_t, _s, l) => {
    listener = l;
    l("e2", '{"id":"e2","author":"a"}');
    return unsubscribe;
  };
  const res = await setup({ live }).app.request(url);
  setTimeout(() => listener("e3", '{"id":"e3"}'), 20);

  const text = await readFrames(res, 3);

  expect(text.match(/^id: /gm)).toHaveLength(3);
  expect(text).toContain("id: e3");
  expect(text.indexOf("id: e1")).toBeLessThan(text.indexOf("id: e3"));
});

test("a failing subscription returns 502 events_error", async () => {
  const live: LiveEvents = async () => {
    throw new Error("pubsub private detail");
  };
  const res = await setup({ live }).app.request(url);
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "events_error" });
});
