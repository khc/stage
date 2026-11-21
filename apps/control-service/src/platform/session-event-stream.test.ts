import { expect, mock, test } from "bun:test";

import { createSessionEventStream } from "./session-event-stream";

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
  const live = createSessionEventStream({ topic } as never, "events", "sub-1");
  const deliver = (attributes: Record<string, string>, data = "{}") => {
    const ack = mock(() => {});
    handlers.message?.({ ack, attributes, data: Buffer.from(data) });
    return ack;
  };
  return { live, deliver, topic, get, createSubscription };
};

test("creates the topic and one subscription lazily and shares them", async () => {
  const { live, topic, get, createSubscription } = setup();
  expect(topic).not.toHaveBeenCalled();

  await live("t1", "s1", () => {});
  await live("t1", "s2", () => {});

  expect(topic).toHaveBeenCalledWith("events");
  expect(get).toHaveBeenCalledWith({ autoCreate: true });
  expect(createSubscription).toHaveBeenCalledTimes(1);
  expect(createSubscription.mock.calls[0]![0]).toBe("sub-1");
});

test("acks and delivers events only to listeners of that task and session", async () => {
  const { live, deliver } = setup();
  const mine = mock((_id: string, _json: string) => {});
  const other = mock((_id: string, _json: string) => {});
  await live("t1", "s1", mine);
  await live("t1", "s2", other);

  const ack = deliver({ taskId: "t1", sessionId: "s1", eventId: "e1" }, '{"id":"e1"}');
  deliver({ taskId: "t2", sessionId: "s1", eventId: "e2" });

  expect(ack).toHaveBeenCalled();
  expect(mine).toHaveBeenCalledTimes(1);
  expect(mine).toHaveBeenCalledWith("e1", '{"id":"e1"}');
  expect(other).not.toHaveBeenCalled();
});

test("ignores messages without routing attributes and stops after unsubscribe", async () => {
  const { live, deliver } = setup();
  const listener = mock((_id: string, _json: string) => {});
  const unsubscribe = await live("t1", "s1", listener);

  deliver({ eventId: "e1" });
  unsubscribe();
  deliver({ taskId: "t1", sessionId: "s1", eventId: "e2" });

  expect(listener).not.toHaveBeenCalled();
});

test("retries startup after a failure", async () => {
  const { live, get } = setup();
  get.mockRejectedValueOnce(new Error("down"));

  await expect(live("t1", "s1", () => {})).rejects.toThrow("down");
  await live("t1", "s1", () => {});

  expect(get).toHaveBeenCalledTimes(2);
});

test("a subscription that reports an error is replaced by a new one for the next listener", async () => {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const remove = mock(async () => {});
  const subscription = {
    on: (name: string, fn: (arg: unknown) => void) => {
      handlers[name] = fn;
    },
    delete: remove,
  };
  const createSubscription = mock(async (_name: string, _opts: unknown) => [subscription]);
  const topic = () => ({ get: async () => [{ createSubscription }] });
  const live = createSessionEventStream({ topic } as never, "events", "sub-1");

  await live("t1", "s1", () => {});
  handlers.error?.(new Error("subscription not found"));
  await live("t1", "s1", () => {});

  expect(remove).toHaveBeenCalledTimes(1);
  expect(createSubscription.mock.calls.map(([name]) => name)).toEqual(["sub-1", "sub-1-1"]);
});

test("an error from a subscription that was already replaced does not drop the new one", async () => {
  const subscriptions: Record<string, (arg: unknown) => void>[] = [];
  const createSubscription = mock(async (_name: string, _opts: unknown) => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    subscriptions.push(handlers);
    return [
      {
        on: (name: string, fn: (arg: unknown) => void) => {
          handlers[name] = fn;
        },
        delete: async () => {},
      },
    ];
  });
  const topic = () => ({ get: async () => [{ createSubscription }] });
  const live = createSessionEventStream({ topic } as never, "events", "sub-1");

  await live("t1", "s1", () => {});
  subscriptions[0]!.error!(new Error("gone"));
  await live("t1", "s1", () => {});
  subscriptions[0]!.error!(new Error("late error from the old one"));
  await live("t1", "s1", () => {});

  expect(createSubscription).toHaveBeenCalledTimes(2);
});

test("stop deletes the subscription", async () => {
  const remove = mock(async () => {});
  const subscription = { on: () => {}, delete: remove };
  const topic = () => ({ get: async () => [{ createSubscription: async () => [subscription] }] });
  const live = createSessionEventStream({ topic } as never, "events", "sub-1");

  await live("t1", "s1", () => {});
  await live.stop?.();

  expect(remove).toHaveBeenCalledTimes(1);
});
