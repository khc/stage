import { expect, mock, test } from "bun:test";

import { createPlatformEventStream } from "./platform-event-stream";

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
  const stream = createPlatformEventStream({ topic } as never, "platform-events", "sub-1");
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
