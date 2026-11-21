import type { Task } from "@/lib/api";

const text = (task: Task) =>
  `${task.name ?? ""} ${task.prompt} ${task.jobName ?? ""} ${task.agentName ?? ""} ${task.taskId}`.toLowerCase();

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

export type TaskNode = Task & { subTasks: TaskNode[] };

// The tasks as a forest: a task without a parent in the list is a root, and each task holds its
// sub-tasks. Built with a stack, so a long chain cannot overflow it; tasks that are each other's
// parent have no root, so they are attached once, under whichever comes first.
export function buildTaskForest(tasks: Task[]): TaskNode[] {
  const children = childrenOf(tasks);
  const attached = new Set<string>();
  const grow = (root: Task): TaskNode => {
    const rootNode: TaskNode = { ...root, subTasks: [] };
    attached.add(root.taskId);
    const stack: [Task, TaskNode][] = [[root, rootNode]];
    while (stack.length) {
      const [task, node] = stack.pop()!;
      for (const child of children.get(task.taskId) ?? []) {
        if (attached.has(child.taskId)) continue;
        attached.add(child.taskId);
        const childNode: TaskNode = { ...child, subTasks: [] };
        node.subTasks.push(childNode);
        stack.push([child, childNode]);
      }
    }
    return rootNode;
  };
  const isChild = new Set([...children.values()].flat().map((task) => task.taskId));
  const roots = tasks.filter((task) => !isChild.has(task.taskId)).map(grow);
  for (const task of tasks) if (!attached.has(task.taskId)) roots.push(grow(task));
  return roots;
}

// Whether a task matches a search: its name, prompt, job, agent or id.
export const taskMatches = (task: Task, query: string) =>
  text(task).includes(query.trim().toLowerCase());

type RowLike = { original: Task; getParentRow: () => RowLike | undefined };

// A row matches a search when it or any ancestor does, so a matching task keeps its sub-tasks.
export function rowMatches(row: RowLike, query: string): boolean {
  for (let current: RowLike | undefined = row; current; current = current.getParentRow())
    if (taskMatches(current.original, query)) return true;
  return false;
}

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
