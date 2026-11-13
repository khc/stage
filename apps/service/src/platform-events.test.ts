import { expect, mock, test } from "bun:test";

import { createApp } from "./app";
import {
  createPlatformPublisher,
  platformEventsFromEnv,
  withPlatformEvents,
} from "./platform-events";

const setup = () => {
  const publishMessage = mock(async (_message: unknown) => "1");
  const publish = createPlatformPublisher(async () => ({ publishMessage }));
  // Events are published in the background, so let them settle first.
  const sent = async () => {
    await Bun.sleep(0);
    return publishMessage.mock.calls.map(
      ([m]) => m as { data: Buffer; attributes: Record<string, string> },
    );
  };
  return { publishMessage, events: withPlatformEvents(publish), sent };
};

test("publishes the event type, task id and JSON body", async () => {
  const { events, sent } = setup();
  const createTask = events.createTask(
    async (i) => ({ taskId: "t1", documents: [], ...i }) as never,
  );

  await createTask({ prompt: "hi", jobName: "job" });

  const [message] = await sent();
  const body = JSON.parse(message!.data.toString());
  expect(message!.attributes).toMatchObject({ eventType: "task.created", taskId: "t1" });
  expect(message!.attributes.eventId).toBe(body.eventId);
  expect(body).toMatchObject({ type: "task.created", taskId: "t1", jobName: "job" });
  expect(typeof body.occurredAt).toBe("number");
});

test("publishes deletes, runs and registrations", async () => {
  const { events, sent } = setup();

  await events.deleteTask(async () => {})("t1");
  await events.runJob(async () => "op")("job", "t1", { sessionId: "s1", message: "m" });
  await events.registerJob(async () => "op")("job");

  expect((await sent()).map((m) => m.attributes.eventType)).toEqual([
    "task.deleted",
    "task.run_requested",
    "job.registration_requested",
  ]);
  expect(JSON.parse((await sent())[1]!.data.toString())).toMatchObject({
    jobName: "job",
    taskId: "t1",
    sessionId: "s1",
  });
});

test("does not wait for a publish that never settles", async () => {
  const publish = createPlatformPublisher(() => new Promise(() => {}));
  const remove = mock(async () => {});

  await withPlatformEvents(publish).deleteTask(remove)("t1");

  expect(remove).toHaveBeenCalledTimes(1);
});

test("the app publishes task create, run and delete events", async () => {
  const { events, sent } = setup();
  const taskId = crypto.randomUUID();
  const task = { taskId, prompt: "hi", jobName: "job", documents: [] };
  const app = createApp(
    events.runJob(async () => "op"),
    async () => [],
    events.createTask(async (input) => ({ ...task, ...input })),
    async () => [],
    async () => task,
    { list: async () => [], get: async () => undefined, delete: async () => false },
    undefined,
    undefined,
    events.deleteTask(async () => {}),
  );

  await app.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi", jobName: "job" }),
  });
  await app.request(`/tasks/${taskId}/run`, { method: "POST" });
  await app.request(`/tasks/${taskId}`, { method: "DELETE" });

  expect((await sent()).map((m) => m.attributes.eventType)).toEqual([
    "task.created",
    "task.run_requested",
    "task.deleted",
  ]);
});

test("publishes nothing when the operation fails", async () => {
  const { events, publishMessage } = setup();
  const failing = events.deleteTask(async () => {
    throw new Error("boom");
  });

  await expect(failing("t1")).rejects.toThrow("boom");
  expect(publishMessage).not.toHaveBeenCalled();
});

test("a failed publish does not fail the operation", async () => {
  const publish = createPlatformPublisher(async () => {
    throw new Error("pubsub down");
  });
  const errors = mock(() => {});
  const spy = console.error;
  console.error = errors;
  try {
    await withPlatformEvents(publish).deleteTask(async () => {})("t1");
    await Bun.sleep(0);
  } finally {
    console.error = spy;
  }
  expect(errors).toHaveBeenCalled();
});

test("document.removed is published only when something was removed", async () => {
  const { events, sent } = setup();
  const documents = events.documents({
    add: async () => ({ documentId: "d1" }),
    remove: async (_t: string, id: string) => id === "d1",
  } as never);

  await documents.add("t1", new File(["x"], "a.txt"));
  await documents.remove("t1", "d1");
  await documents.remove("t1", "missing");

  expect((await sent()).map((m) => m.attributes.eventType)).toEqual([
    "document.added",
    "document.removed",
  ]);
  expect(JSON.parse((await sent())[0]!.data.toString())).toMatchObject({
    taskId: "t1",
    documentId: "d1",
  });
});

test("resolves the topic once and retries after a topic failure", async () => {
  const publishMessage = mock(async (_message: unknown) => "1");
  let calls = 0;
  const getTopic = mock(async () => {
    if (++calls === 1) throw new Error("down");
    return { publishMessage };
  });
  const publish = createPlatformPublisher(getTopic);

  await expect(publish("task.deleted", { taskId: "t1" })).rejects.toThrow("down");
  await publish("task.deleted", { taskId: "t1" });
  await publish("task.deleted", { taskId: "t1" });

  expect(getTopic).toHaveBeenCalledTimes(2);
  expect(publishMessage).toHaveBeenCalledTimes(2);
});

test("is disabled without PLATFORM_EVENTS_TOPIC", () => {
  expect(platformEventsFromEnv({}, { topic: mock() } as never)).toBeUndefined();
  expect(
    platformEventsFromEnv({ PLATFORM_EVENTS_TOPIC: "t" }, { topic: mock() } as never),
  ).toBeDefined();
});
