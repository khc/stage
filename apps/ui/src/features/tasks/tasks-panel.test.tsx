import { expect, test } from "bun:test";

import type { Task } from "@/lib/api";
import { renderWithApp } from "@/test-utils";

import { TasksPanel } from "./tasks-panel";

const tasks = (count: number): Task[] =>
  Array.from({ length: count }, (_, i) => ({
    taskId: `t${i}`,
    name: `Task ${i}`,
    prompt: `prompt ${i}`,
    jobName: "job",
  })) as Task[];

const render = (list: Task[], limit?: number) =>
  renderWithApp(<TasksPanel title="Tasks" limit={limit} />, [[["tasks"], { tasks: list }]]);

test("the overview shows `limit` tasks and links to the full list", async () => {
  const html = await render(tasks(9), 8);
  expect(html).toContain("8 of 9 tasks shown");
  expect(html).toContain("View all");
  expect(html).not.toContain("Task 8<");
});

test("the tasks page pages by ten and shows the page controls", async () => {
  const html = await render(tasks(11));
  expect(html).toContain("10 of 11 tasks shown");
  expect(html).toContain("Page 1 of 2");
  expect(html).not.toContain("View all");
});

test("a task with sub-tasks starts collapsed and has an expand toggle", async () => {
  const list = [
    ...tasks(1),
    { ...tasks(2)[1]!, taskId: "kid", name: "Kid", parentTaskId: "t0" } as Task,
  ];
  const html = await render(list);
  expect(html).toContain('aria-label="Show sub-tasks"');
  expect(html).not.toContain("Kid");
});
