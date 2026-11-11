import { createEvent } from "@google/adk";
import { expect, mock, test } from "bun:test";
import { createEventPublisher, publisherFromEnv } from "./event-publisher";

const event = createEvent({ content: { role: "model", parts: [{ text: "hi" }] } });

test("publishes the event JSON with session, task and event attributes", async () => {
  const publishMessage = mock(async (_message: unknown) => "1");
  const publish = createEventPublisher(async () => ({ publishMessage }));

  await publish(event, { sessionId: "s1", taskId: "t1" });

  const [message] = publishMessage.mock.calls[0] as [
    { data: Buffer; attributes: Record<string, string> },
  ];
  expect(JSON.parse(message.data.toString())).toMatchObject({ id: event.id });
  expect(message.attributes).toEqual({
    eventId: event.id,
    sessionId: "s1",
    taskId: "t1",
  });
});

test("resolves the topic once and retries after a topic failure", async () => {
  const publishMessage = mock(async (_message: unknown) => "1");
  let calls = 0;
  const getTopic = mock(async () => {
    if (++calls === 1) throw new Error("down");
    return { publishMessage };
  });
  const publish = createEventPublisher(getTopic);

  await expect(publish(event, { sessionId: "s1" })).rejects.toThrow("down");
  await publish(event, { sessionId: "s1" });
  await publish(event, { sessionId: "s1" });

  expect(getTopic).toHaveBeenCalledTimes(2);
  expect(publishMessage).toHaveBeenCalledTimes(2);
});

test("publishing is disabled without PUBSUB_TOPIC", () => {
  expect(publisherFromEnv({}, { topic: mock() } as never)).toBeUndefined();
});

test("creates the configured topic on first use", async () => {
  const publishMessage = mock(async (_message: unknown) => "1");
  const get = mock(async () => [{ publishMessage }]);
  const topic = mock((_name: string) => ({ get }));
  const publish = publisherFromEnv({ PUBSUB_TOPIC: "events" }, {
    topic,
  } as never)!;

  await publish(event, { sessionId: "s1" });

  expect(topic).toHaveBeenCalledWith("events");
  expect(get).toHaveBeenCalledWith({ autoCreate: true });
});
