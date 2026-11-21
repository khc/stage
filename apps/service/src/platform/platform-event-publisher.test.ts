import { expect, mock, test } from "bun:test";

import { createApp } from "../app";
import { createTasksService } from "../modules/tasks/tasks-service";
import type { TasksStore } from "../modules/tasks/tasks-store";
import type { CloudRunJobs } from "./cloud-run-jobs-client";
import {
  createPlatformPublisher,
  createPlatformEvents,
  withPlatformEvents,
} from "./platform-event-publisher";

// A complete TasksStore of stubs; a test overrides only what it checks.
const tasksStore = (overrides: Partial<TasksStore> = {}): TasksStore => ({
  create: async (i) => ({ taskId: "t1", documents: [], ...i }) as never,
  list: async () => [],
  listChildren: async () => [],
  get: async () => undefined,
  delete: async () => true,
  ...overrides,
});

const cloudRunJobs = (overrides: Partial<CloudRunJobs> = {}): CloudRunJobs => ({
  list: async () => [],
  run: async () => "op",
  registerAgents: async () => "op",
  ...overrides,
});

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
  await events.tasksStore(tasksStore()).create({ name: "Greeting", prompt: "hi", jobName: "job" });

  const [message] = await sent();
  const body = JSON.parse(message!.data.toString());
  expect(message!.attributes).toMatchObject({ eventType: "task.created", taskId: "t1" });
  expect(message!.attributes.eventId).toBe(body.eventId);
  expect(body).toMatchObject({ type: "task.created", taskId: "t1", jobName: "job" });
  expect(typeof body.occurredAt).toBe("number");
});

test("publishes deletes, runs and registrations", async () => {
  const { events, sent } = setup();

  await events.tasksStore(tasksStore()).delete("t1");
  const jobs = events.cloudRunJobs(cloudRunJobs());
  await jobs.run("job", "t1", "s1");
  await jobs.registerAgents("job");

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
  const remove = mock(async () => true);

  await withPlatformEvents(publish)
    .tasksStore(tasksStore({ delete: remove }))
    .delete("t1");

  expect(remove).toHaveBeenCalledTimes(1);
});

test("the app publishes task create, run and delete events", async () => {
  const { events, sent } = setup();
  const taskId = crypto.randomUUID();
  const task = { taskId, name: "Greeting", prompt: "hi", jobName: "job", documents: [] };
  const tasksService = createTasksService({
    tasksStore: events.tasksStore(
      tasksStore({ create: async (input) => ({ ...task, ...input }), get: async () => task }),
    ),
    agentRegistry: { list: async () => [] },
    cloudRunJobs: events.cloudRunJobs(cloudRunJobs()),
    sessionsStore: {
      create: async () => "s1",
      list: async () => [],
      get: async () => undefined,
      delete: async () => false,
      queueMessage: async () => true,
      clearMessage: async () => {},
    },
  });
  const app = createApp({
    healthService: { check: () => ({ status: "ok" }) },
    tasksService,
    sessionsService: {} as never,
    agentsService: {} as never,
    providersService: {} as never,
    a2aService: {} as never,
  });

  await app.handle(
    new Request("http://localhost/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Greeting", prompt: "hi", jobName: "job" }),
    }),
  );
  await app.handle(new Request(`http://localhost/tasks/${taskId}/run`, { method: "POST" }));
  await app.handle(new Request(`http://localhost/tasks/${taskId}`, { method: "DELETE" }));

  expect((await sent()).map((m) => m.attributes.eventType)).toEqual([
    "task.created",
    "task.run_requested",
    "task.deleted",
  ]);
});

test("publishes nothing when the operation fails", async () => {
  const { events, publishMessage } = setup();
  const failing = events.tasksStore(
    tasksStore({
      delete: async () => {
        throw new Error("boom");
      },
    }),
  );

  await expect(failing.delete("t1")).rejects.toThrow("boom");
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
    await withPlatformEvents(publish).tasksStore(tasksStore()).delete("t1");
    await Bun.sleep(0);
  } finally {
    console.error = spy;
  }
  expect(errors).toHaveBeenCalled();
});

test("document.removed is published only when something was removed", async () => {
  const { events, sent } = setup();
  const documents = events.documentsStore({
    create: async () => ({ documentId: "d1" }),
    delete: async (_t: string, id: string) => id === "d1",
  } as never);

  await documents.create("t1", new File(["x"], "a.txt"));
  await documents.delete("t1", "d1");
  await documents.delete("t1", "missing");

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

test("createPlatformEvents resolves the named topic lazily, creating it on first publish", async () => {
  const publishMessage = mock(async (_message: unknown) => "1");
  const get = mock(async (_options: unknown) => [{ publishMessage }]);
  const topic = mock((_name: string) => ({ get }));
  const events = createPlatformEvents({ topic } as never, "platform-events");
  expect(topic).not.toHaveBeenCalled();
  await events.tasksStore(tasksStore()).delete("t1");
  await Bun.sleep(0);
  expect(topic).toHaveBeenCalledWith("platform-events");
  expect(get).toHaveBeenCalledWith({ autoCreate: true });
  expect(publishMessage).toHaveBeenCalledTimes(1);
});

test("task.deleted is published only when a task was deleted", async () => {
  const { events, sent } = setup();
  expect(await events.tasksStore(tasksStore({ delete: async () => false })).delete("missing")).toBe(
    false,
  );
  expect(await sent()).toEqual([]);
});
