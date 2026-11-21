import { parseArgs } from "node:util";

import { FieldPath, Firestore, type QueryDocumentSnapshot } from "@google-cloud/firestore";

const LEGACY_JOB_APPS = new Set([
  "generic-agents",
  "poet-agents",
  "knowledge-agents",
  "orchestrator-agents",
]);

const LEGACY_AGENT_NAMES: Record<string, string> = {
  document_analyser: "document-analyser",
};

async function* documents(db: Firestore, collection: string) {
  let last: QueryDocumentSnapshot | undefined;
  while (true) {
    let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(250);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    yield* page.docs;
    if (page.size < 250) return;
    last = page.docs.at(-1);
  }
}

export const migrateLegacyTaskNames = async (
  db: Firestore,
  { apply = false, env = "lcl" } = {},
) => {
  const result = { tasks: 0, unchangedTasks: 0 };
  for await (const doc of documents(db, "tasks")) {
    const jobName: unknown = doc.get("jobName");
    const agentName: unknown = doc.get("agentName");
    const patch: Record<string, string> = {};
    if (typeof jobName === "string" && LEGACY_JOB_APPS.has(jobName)) {
      patch.jobName = `stage--${jobName}--job-${env}`;
    }
    if (typeof agentName === "string" && agentName in LEGACY_AGENT_NAMES) {
      patch.agentName = LEGACY_AGENT_NAMES[agentName]!;
    }
    if (Object.keys(patch).length === 0) {
      result.unchangedTasks++;
      continue;
    }
    if (apply) await doc.ref.update(patch, { lastUpdateTime: doc.updateTime });
    result.tasks++;
  }
  return result;
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      env: { type: "string", default: "lcl" },
    },
  });
  const result = await migrateLegacyTaskNames(new Firestore(), {
    apply: values.apply,
    env: values.env,
  });
  console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry-run", ...result }));
}
