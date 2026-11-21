import { expect, test } from "bun:test";

import type { Task } from "@/lib/api";

import {
  buildTaskForest,
  countDescendants,
  rowMatches,
  taskMatches,
  type TaskNode,
} from "./task-tree";

const task = (id: string, parent?: string, name = id): Task =>
  ({
    taskId: id,
    name,
    prompt: `prompt ${id}`,
    jobName: "job",
    ...(parent && { parentTaskId: parent }),
  }) as Task;

// The forest as "depth:id" in order.
const shape = (tasks: Task[]) => {
  const out: string[] = [];
  const walk = (nodes: TaskNode[], depth: number) =>
    nodes.forEach((node) => {
      out.push(`${depth}:${node.taskId}`);
      walk(node.subTasks, depth + 1);
    });
  walk(buildTaskForest(tasks), 0);
  return out;
};

test("a task without a parent is a root, and a sub-task sits under its parent", () => {
  const tasks = [task("a"), task("b"), task("a1", "a"), task("a2", "a"), task("a1x", "a1")];
  expect(shape(tasks)).toEqual(["0:a", "1:a1", "2:a1x", "1:a2", "0:b"]);
});

test("a sub-task whose parent is not in the list is shown as a root", () => {
  expect(shape([task("a"), task("orphan", "gone")])).toEqual(["0:a", "0:orphan"]);
});

test("tasks that are each other's parent are still shown, once", () => {
  expect(shape([task("a", "b"), task("b", "a")])).toEqual(["0:a", "1:b"]);
});

test("a search matches a task's name, prompt, job, agent and id", () => {
  const t = { ...task("id-1", undefined, "Haiku"), agentName: "poet" } as Task;
  expect(["haiku", "PROMPT", "job", "poet", "id-1"].every((q) => taskMatches(t, q))).toBe(true);
  expect(taskMatches(t, "zzz")).toBe(false);
});

test("counts the sub-tasks of a task, and theirs", () => {
  const tasks = [task("a"), task("a1", "a"), task("a2", "a"), task("a1x", "a1"), task("b")];
  expect(countDescendants(tasks, "a")).toBe(3);
  expect(countDescendants(tasks, "a1")).toBe(1);
  expect(countDescendants(tasks, "b")).toBe(0);
});

test("counting terminates when tasks are each other's parent", () => {
  expect(countDescendants([task("a", "b"), task("b", "a")], "a")).toBe(1);
});

test("a very deep chain of sub-tasks neither overflows the stack nor is lost", () => {
  const chain = Array.from({ length: 5_000 }, (_, i) => task(`t${i}`, i ? `t${i - 1}` : undefined));
  expect(buildTaskForest(chain)).toHaveLength(1);
  expect(countDescendants(chain, "t0")).toBe(4_999);
});

// A row of the forest, with its parent chain, as the table hands it to the search.
const rowOf = (nodes: TaskNode[], id: string) => {
  const find = (
    list: TaskNode[],
    parent?: ReturnType<typeof makeRow>,
  ): ReturnType<typeof makeRow> | undefined => {
    for (const node of list) {
      const row = makeRow(node, parent);
      if (node.taskId === id) return row;
      const found = find(node.subTasks, row);
      if (found) return found;
    }
  };
  return find(nodes)!;
};
type Row = { original: Task; getParentRow: () => Row | undefined };
const makeRow = (original: Task, parent?: Row): Row => ({ original, getParentRow: () => parent });

test("a sub-task matches a search when its parent does, so a matching parent keeps its sub-tasks", () => {
  const forest = buildTaskForest([task("a", undefined, "Orchestrator"), task("a1", "a", "Haiku")]);
  expect(rowMatches(rowOf(forest, "a1"), "orchestrator")).toBe(true);
  expect(rowMatches(rowOf(forest, "a"), "orchestrator")).toBe(true);
});

test("a parent does not match because of its sub-task, and an unrelated task does not match", () => {
  const forest = buildTaskForest([
    task("a", undefined, "Orchestrator"),
    task("a1", "a", "Haiku"),
    task("b", undefined, "Other"),
  ]);
  expect(rowMatches(rowOf(forest, "a"), "haiku")).toBe(false);
  expect(rowMatches(rowOf(forest, "b"), "orchestrator")).toBe(false);
});

test("a task without a job does not match the word undefined", () => {
  const noJob = { taskId: "x", name: "X", prompt: "p" } as Task;
  expect(taskMatches(noJob, "undefined")).toBe(false);
});
