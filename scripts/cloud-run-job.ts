import type { protos } from "@google-cloud/run";

type Env = Record<string, string | undefined>;

export const jobEnvironment = (env: Env, project: string) => {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required (set it in .env)");
  return [
    { name: "GOOGLE_CLOUD_PROJECT", value: project },
    {
      name: "FIRESTORE_EMULATOR_HOST",
      value: env.JOB_FIRESTORE_EMULATOR_HOST || "floci-gcp:4588",
    },
    {
      name: "PUBSUB_EMULATOR_HOST",
      value: env.JOB_PUBSUB_EMULATOR_HOST || "floci-gcp:4588",
    },
    { name: "PUBSUB_TOPIC", value: env.PUBSUB_TOPIC || "agent-events" },
    { name: "GEMINI_API_KEY", value: env.GEMINI_API_KEY },
    ...["AGENT_MODEL", "GOOGLE_GENAI_USE_VERTEXAI"].flatMap((name) =>
      env[name] ? [{ name, value: env[name] }] : [],
    ),
  ];
};

// The job and image a run of this script targets. JOB_APP (generic, poet) gives
// both by convention (<app>-agents and stage-<app>:latest); JOB_NAME and
// JOB_IMAGE override either. Nothing is guessed when neither is set.
export const jobTarget = (env: Env) => {
  const job = env.JOB_NAME || (env.JOB_APP ? `${env.JOB_APP}-agents` : undefined);
  const image = env.JOB_IMAGE || (env.JOB_APP ? `stage-${env.JOB_APP}:latest` : undefined);
  if (!job || !image)
    throw new Error("Set JOB_APP (for example generic), or JOB_NAME and JOB_IMAGE");
  return { job, image };
};

// A run is not safe to repeat: each attempt of a failed first run would create
// another session, and a retried resume would append its message again. Cloud
// Run Jobs retry a failed task 3 times unless told otherwise.
export const jobTaskTemplate = (
  containers: protos.google.cloud.run.v2.IContainer[],
  base: protos.google.cloud.run.v2.ITaskTemplate = {},
): protos.google.cloud.run.v2.ITaskTemplate => ({ ...base, maxRetries: 0, containers });

if (import.meta.main) {
  try {
    const mode = process.argv[2];
    if (mode !== "create" && mode !== "update") throw new Error("Expected create or update");
    const env = process.env;
    const project = env.JOB_PROJECT || "floci-local";
    const region = env.JOB_REGION || "us-central1";
    const { job, image } = jobTarget(env);
    const name = `projects/${project}/locations/${region}/jobs/${job}`;
    const base = (env.JOB_FLOCI || "http://localhost:4588").replace(/\/$/, "");
    const collection = `${base}/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs`;
    const url = new URL(
      mode === "create" ? collection : `${collection}/${encodeURIComponent(job)}`,
    );
    url.searchParams.set(
      mode === "create" ? "jobId" : "updateMask",
      mode === "create" ? job : "template",
    );
    const body: protos.google.cloud.run.v2.IJob = {
      ...(mode === "update" ? { name } : {}),
      template: {
        template: jobTaskTemplate([
          {
            image,
            env: jobEnvironment(env, project),
          },
        ]),
      },
    };
    if (mode === "update") {
      const current = await fetch(`${collection}/${encodeURIComponent(job)}`);
      if (!current.ok) throw new Error(`Cloud Run job read failed: HTTP ${current.status}`);
      const existing = (await current.json()) as protos.google.cloud.run.v2.IJob;
      const template = existing.template;
      const containers = template?.template?.containers;
      if (!template?.template || !containers?.length)
        throw new Error("Existing job has no container to update");
      const [agent, ...others] = containers;
      const requiredEnv = jobEnvironment(env, project);
      const replacedNames = new Set([
        "AGENT_MESSAGE",
        "RUN_ID",
        "TASK_ID",
        ...requiredEnv.map(({ name: envName }) => envName),
      ]);
      body.template = {
        ...template,
        template: jobTaskTemplate(
          [
            {
              ...agent,
              image,
              env: [
                ...(agent?.env ?? []).filter((entry) => !replacedNames.has(entry.name ?? "")),
                ...requiredEnv,
              ],
            },
            ...others,
          ],
          template.template,
        ),
      };
    }
    const response = await fetch(url, {
      method: mode === "create" ? "POST" : "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Cloud Run job ${mode} failed: HTTP ${response.status}`);
    // Job responses include credentials; report only the resource name.
    console.log(`${mode === "create" ? "Created" : "Updated"} ${name}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Cloud Run job request failed");
    process.exitCode = 1;
  }
}
