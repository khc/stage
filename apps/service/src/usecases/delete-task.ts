import { guard } from "../errors";
import type { DocumentStore } from "../stores/document-store";
import type { SessionStore } from "../stores/session-store";
import type { TaskStore } from "../stores/task-store";

export type DeleteTaskDeps = {
  tasks: Pick<TaskStore, "get" | "delete">;
  sessions: SessionStore;
  documents?: DocumentStore;
};

// Deletes a task with its sessions, then releases the documents nobody else uses.
export const deleteTaskWithSessions = async (
  { tasks, sessions, documents }: DeleteTaskDeps,
  taskId: string,
): Promise<"deleted" | "not_found"> =>
  guard("task_error", async () => {
    const task = await tasks.get(taskId);
    if (!task) return "not_found";
    // Sessions go first, so a failure leaves the task in place to retry.
    for (const { id } of await sessions.list(taskId)) await sessions.delete(taskId, id);
    await tasks.delete(taskId);
    // A failure here is only logged, since the task is already gone.
    await documents
      ?.release((task.documents ?? []).map((d) => d.documentId))
      .catch((err) => console.error(err));
    return "deleted";
  });
