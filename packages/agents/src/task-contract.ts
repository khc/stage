import type { DocumentSnapshot, Firestore } from "@google-cloud/firestore";
import { z } from "zod";

import type { ModelRef } from "./model-ref";

export type TaskContract = {
  taskId: string;
  name?: string;
  prompt: string;
  jobName?: string;
  agentName?: string;
  // The model the task starts on; a message may choose another.
  defaultModel?: ModelRef;
  // Set on a task that an agent delegated: the task and the session that caused it.
  parentTaskId?: string;
  parentSessionId?: string;
  documents?: { documentId: string }[];
};
// The prompt a job accepts, for a task's first turn and for a queued message.
export const promptSchema = z.string().trim().min(1).max(10_000);
export type GetTask = (taskId: string) => Promise<TaskContract | undefined>;

export const toContract = (doc: DocumentSnapshot): TaskContract => {
  const name = doc.get("name");
  const jobName = doc.get("jobName");
  const agentName = doc.get("agentName");
  const defaultModel = doc.get("defaultModel");
  const parentTaskId = doc.get("parentTaskId");
  const parentSessionId = doc.get("parentSessionId");
  const documents = doc.get("documents");
  return {
    taskId: doc.id,
    ...(name !== undefined && { name }),
    prompt: doc.get("prompt"),
    ...(jobName !== undefined && { jobName }),
    ...(agentName !== undefined && { agentName }),
    ...(defaultModel !== undefined && { defaultModel }),
    ...(parentTaskId !== undefined && { parentTaskId }),
    ...(parentSessionId !== undefined && { parentSessionId }),
    ...(documents !== undefined && { documents }),
  };
};

export const createGetTask =
  (db: Pick<Firestore, "collection">): GetTask =>
  async (taskId) => {
    const doc = await db.collection("tasks").doc(taskId).get();
    return doc.exists ? toContract(doc) : undefined;
  };
