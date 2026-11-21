import { JobsClient, type protos } from "@google-cloud/run";

// The emulator needs no credentials: plain fetch, no Authorization header.
const noAuth = {
  universeDomain: "googleapis.com",
  getRequestHeaders: async () => ({}),
  fetch: (url: string, init?: RequestInit) =>
    fetch(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    }),
};

// The SDK client: Floci when CLOUD_RUN_EMULATOR_HOST is set, real Cloud Run otherwise.
export const createJobsClient = (env: Record<string, string | undefined>): JobsClient => {
  const emulator = env.CLOUD_RUN_EMULATOR_HOST;
  if (!emulator) return new JobsClient();

  const { hostname, port } = new URL(`http://${emulator}`);
  if (!port) throw new Error("CLOUD_RUN_EMULATOR_HOST must be host:port");

  return new JobsClient({
    fallback: "rest",
    apiEndpoint: hostname,
    port,
    protocol: "http",
    authClient: noAuth as never,
  });
};

type JobsApi = Pick<JobsClient, "listJobs" | "locationPath" | "runJob" | "jobPath">;
type CloudRunJobsConfig = { project: string; location: string };
type Env = { name: string; value: string }[];

// The Cloud Run Jobs of the configured project and region.
export type CloudRunJobs = {
  list: () => Promise<protos.google.cloud.run.v2.IJob[]>;
  // Starts one execution. Resuming passes only the session id; the message is queued in Firestore.
  run: (job: string, taskId: string, sessionId?: string) => Promise<string>;
  // Runs the job image in its `register` mode, which records its agents.
  registerAgents: (job: string) => Promise<string>;
};

export const createCloudRunJobs = (
  client: JobsApi,
  { project, location }: CloudRunJobsConfig,
): CloudRunJobs => {
  const execute = async (job: string, override: { env: Env; args?: string[] }) => {
    const [operation] = await client.runJob({
      name: client.jobPath(project, location, job),
      overrides: { containerOverrides: [override] },
    });
    return operation.name ?? "";
  };
  return {
    async list() {
      const [jobs] = await client.listJobs({ parent: client.locationPath(project, location) });
      return jobs;
    },
    run(job, taskId, sessionId) {
      const env = [{ name: "TASK_ID", value: taskId }];
      if (sessionId) env.push({ name: "SESSION_ID", value: sessionId });
      return execute(job, { env });
    },
    registerAgents(job) {
      return execute(job, { args: ["register"], env: [{ name: "JOB_NAME", value: job }] });
    },
  };
};
