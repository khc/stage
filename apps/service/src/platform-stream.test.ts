import { expect, mock, test } from "bun:test";

import { createApp } from "./app";
import { createPlatformStream, type PlatformStream } from "./platform-stream";

const setup = () => {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const subscription = {
    on: (name: string, fn: (arg: unknown) => void) => {
      handlers[name] = fn;
    },
  };
  const createSubscription = mock(async (_name: string, _opts: unknown) => [subscription]);
  const get = mock(async (_opts: unknown) => [{ createSubscription }]);
  const topic = mock((_name: string) => ({ get }));
  const stream = createPlatformStream({ topic } as never, "platform-events", "sub-1");
  const deliver = (attributes: Record<string, string>, data = "{}") => {
    const ack = mock(() => {});
    handlers.message?.({ ack, attributes, data: Buffer.from(data) });
    return ack;
  };
  return { stream, deliver, topic, createSubscription };
};

test("shares one lazily created subscription and delivers every event to all listeners", async () => {
  const { stream, deliver, topic, createSubscription } = setup();
  expect(topic).not.toHaveBeenCalled();
  const a = mock((_id: string, _json: string) => {});
  const b = mock((_id: string, _json: string) => {});
  await stream(a);
  await stream(b);

  const ack = deliver({ eventId: "e1", eventType: "task.created" }, '{"type":"task.created"}');

  expect(topic).toHaveBeenCalledWith("platform-events");
  expect(createSubscription).toHaveBeenCalledTimes(1);
  expect(ack).toHaveBeenCalled();
  expect(a).toHaveBeenCalledWith("e1", '{"type":"task.created"}');
  expect(b).toHaveBeenCalledTimes(1);
});

test("ignores messages without an event id and stops after unsubscribe", async () => {
  const { stream, deliver } = setup();
  const listener = mock((_id: string, _json: string) => {});
  const unsubscribe = await stream(listener);

  deliver({});
  unsubscribe();
  deliver({ eventId: "e2" });

  expect(listener).not.toHaveBeenCalled();
});

const appWith = (platformStream?: PlatformStream) =>
  createApp(
    async () => "",
    async () => [],
    async (i) => ({ taskId: crypto.randomUUID(), ...i }),
    async () => [],
    async () => undefined,
    {
      list: async () => [],
      get: async () => undefined,
      delete: async () => false,
      queueMessage: async () => true,
      clearMessage: async () => {},
    },
    undefined,
    undefined,
    undefined,
    undefined,
    platformStream,
  );

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

test("GET /events is 501 without a platform stream", async () => {
  const res = await appWith().request("/events");

  expect(res.status).toBe(501);
  expect(await res.json()).toEqual({ error: "not_supported" });
});

test("GET /events streams each platform event once and unsubscribes on abort", async () => {
  const unsubscribe = mock(() => {});
  let push: (id: string, json: string) => void = () => {};
  const platformStream: PlatformStream = async (listener) => {
    push = listener;
    return unsubscribe;
  };

  const res = await appWith(platformStream).request("/events");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  push("e1", '{"type":"task.created"}');
  push("e1", '{"type":"task.created"}');
  push("e2", '{"type":"task.deleted"}');
  const body = await readFrames(res, 2);

  expect(body).toContain('data: {"type":"task.created"}\nid: e1');
  expect(body).toContain('data: {"type":"task.deleted"}\nid: e2');
  expect(body.match(/id: e1/g)).toHaveLength(1);
  await Bun.sleep(10);
  expect(unsubscribe).toHaveBeenCalled();
});

test("GET /events keeps its duplicate memory bounded", async () => {
  let push: (id: string, json: string) => void = () => {};
  const res = await appWith(async (listener) => {
    push = listener;
    return () => {};
  }).request("/events");

  for (let i = 0; i < 1001; i++) push(`e${i}`, "{}");
  await Bun.sleep(20);
  push("e0", "{}");
  const body = await readFrames(res, 1002);

  expect(body.match(/id: e0\n/g)).toHaveLength(2);
});

test("GET /events is 502 when the subscription cannot start", async () => {
  const res = await appWith(async () => {
    throw new Error("down");
  }).request("/events");

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "events_error" });
});
