import type { Task } from "@/lib/api";

export type TaskRow = { task: Task; depth: number; hasChildren: boolean };

const text = (task: Task) =>
  `${task.name ?? ""} ${task.prompt} ${task.jobName} ${task.agentName ?? ""} ${task.taskId}`.toLowerCase();

// The sub-tasks of each task in the list; a task whose parent is not in the list has no entry as a child.
const childrenOf = (tasks: Task[]) => {
  const ids = new Set(tasks.map((task) => task.taskId));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    const parent = task.parentTaskId;
    if (parent && parent !== task.taskId && ids.has(parent))
      children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  return children;
};

// The tasks in table order: each task is followed by its sub-tasks, and theirs, indented by `depth`.
// A search keeps a matching task with its ancestors and its sub-tasks, and shows everything it finds
// expanded; without one, the sub-tasks of a `collapsed` task are left out.
export function buildTaskTree(
  tasks: Task[],
  search: string,
  collapsed: ReadonlySet<string>,
): TaskRow[] {
  const children = childrenOf(tasks);
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const query = search.trim().toLowerCase();

  let shown: Set<string> | undefined;
  if (query) {
    shown = new Set();
    for (const match of tasks.filter((candidate) => text(candidate).includes(query))) {
      // The task, its sub-tasks and theirs (a stack, not recursion: a chain can be long)...
      const stack = [match];
      while (stack.length) {
        const current = stack.pop()!;
        if (shown.has(current.taskId) && current !== match) continue;
        shown.add(current.taskId);
        stack.push(
          ...(children.get(current.taskId) ?? []).filter((kid) => !shown!.has(kid.taskId)),
        );
      }
      // ...and its ancestors, with a guard against a parent loop.
      const seen = new Set([match.taskId]);
      for (
        let parent = byId.get(match.parentTaskId ?? "");
        parent && !seen.has(parent.taskId);
        parent = byId.get(parent.parentTaskId ?? "")
      ) {
        seen.add(parent.taskId);
        shown.add(parent.taskId);
      }
    }
  }

  const rows: TaskRow[] = [];
  const visited = new Set<string>();
  // Depth first with an explicit stack. A task under a collapsed one is still visited, so it is not
  // taken for a root of its own later.
  const walk = (root: Task) => {
    const stack = [{ task: root, depth: 0, hidden: false }];
    while (stack.length) {
      const { task, depth, hidden } = stack.pop()!;
      if (visited.has(task.taskId)) continue;
      visited.add(task.taskId);
      const all = children.get(task.taskId) ?? [];
      if (!hidden && (!shown || shown.has(task.taskId)))
        rows.push({ task, depth, hasChildren: all.length > 0 });
      const hideBelow = hidden || (!shown && collapsed.has(task.taskId));
      for (let i = all.length - 1; i >= 0; i--)
        stack.push({ task: all[i]!, depth: depth + 1, hidden: hideBelow });
    }
  };
  const isChild = new Set([...children.values()].flat().map((task) => task.taskId));
  for (const task of tasks) if (!isChild.has(task.taskId)) walk(task);
  // Tasks that are each other's parent have no root: they are shown as roots, once.
  for (const task of tasks) if (!visited.has(task.taskId)) walk(task);
  return rows;
}

// The indent of a sub-task stops growing after this many levels.
export const indentLevel = (depth: number) => Math.min(depth, 8);

// How many tasks hang below this one, counting sub-tasks of sub-tasks.
export function countDescendants(tasks: Task[], taskId: string): number {
  const children = childrenOf(tasks);
  const seen = new Set([taskId]);
  const stack = [taskId];
  while (stack.length)
    for (const child of children.get(stack.pop()!) ?? [])
      if (!seen.has(child.taskId)) {
        seen.add(child.taskId);
        stack.push(child.taskId);
      }
  return seen.size - 1;
}
