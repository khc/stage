import type { Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

// The SDK's InMemoryTaskStore keeps every task forever. This one keeps the `limit` most recently
// saved and drops the oldest, so a caller cannot grow the gateway's memory without bound. The message
// history is not kept either: it only repeats what the caller sent, and can be large.
export const createBoundedTaskStore = (limit: number): TaskStore => {
  const tasks = new Map<string, Task>();
  return {
    async save(task) {
      tasks.delete(task.id);
      const { history: _history, ...kept } = task;
      tasks.set(task.id, structuredClone(kept));
      for (const id of tasks.keys()) {
        if (tasks.size <= limit) break;
        tasks.delete(id);
      }
    },
    async load(taskId) {
      const task = tasks.get(taskId);
      return task && structuredClone(task);
    },
  };
};
