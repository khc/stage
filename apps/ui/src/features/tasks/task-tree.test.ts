import { expect, test } from "bun:test";

import type { Task } from "@/lib/api";

import { buildTaskTree, countDescendants, indentLevel } from "./task-tree";

const task = (id: string, parent?: string, name = id): Task =>
  ({
    taskId: id,
    name,
    prompt: `prompt ${id}`,
    jobName: "job",
    ...(parent && { parentTaskId: parent }),
  }) as Task;

const rows = (tasks: Task[], search = "", collapsed: string[] = []) =>
  buildTaskTree(tasks, search, new Set(collapsed)).map(
    ({ task, depth }) => `${depth}:${task.taskId}`,
  );

test("a task without a parent is a root, and a sub-task follows its parent, indented", () => {
  const tasks = [task("a"), task("b"), task("a1", "a"), task("a2", "a"), task("a1x", "a1")];
  expect(rows(tasks)).toEqual(["0:a", "1:a1", "2:a1x", "1:a2", "0:b"]);
});

test("a sub-task whose parent is not in the list is shown as a root", () => {
  expect(rows([task("a"), task("orphan", "gone")])).toEqual(["0:a", "0:orphan"]);
});

test("rows say whether a task has sub-tasks", () => {
  const tree = buildTaskTree([task("a"), task("a1", "a")], "", new Set());
  expect(tree.map((row) => row.hasChildren)).toEqual([true, false]);
});

test("a collapsed task hides its sub-tasks, and theirs", () => {
  const tasks = [task("a"), task("a1", "a"), task("a1x", "a1"), task("b")];
  expect(rows(tasks, "", ["a"])).toEqual(["0:a", "0:b"]);
  expect(rows(tasks, "", ["a1"])).toEqual(["0:a", "1:a1", "0:b"]);
});

test("a search that matches a sub-task keeps its ancestors, and ignores the collapsed state", () => {
  const tasks = [
    task("a", undefined, "Orchestrator"),
    task("a1", "a", "Haiku"),
    task("b", undefined, "Other"),
  ];
  expect(rows(tasks, "haiku", ["a"])).toEqual(["0:a", "1:a1"]);
});

test("a search that matches a parent keeps all its sub-tasks", () => {
  const tasks = [
    task("a", undefined, "Orchestrator"),
    task("a1", "a", "Haiku"),
    task("b", undefined, "Other"),
  ];
  expect(rows(tasks, "orchestrator")).toEqual(["0:a", "1:a1"]);
});

test("a search with no match shows nothing", () => {
  expect(rows([task("a")], "zzz")).toEqual([]);
});

test("tasks that are each other's parent are still shown, once", () => {
  expect(rows([task("a", "b"), task("b", "a")])).toEqual(["0:a", "1:b"]);
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
  expect(buildTaskTree(chain, "", new Set())).toHaveLength(5_000);
  expect(buildTaskTree(chain, "t4999", new Set())).toHaveLength(5_000);
  expect(countDescendants(chain, "t0")).toBe(4_999);
});

test("the indent stops growing after a few levels", () => {
  expect([0, 1, 7, 8, 9, 5_000].map(indentLevel)).toEqual([0, 1, 7, 8, 8, 8]);
});
