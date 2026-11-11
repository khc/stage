import { JobsClient } from "@google-cloud/run";

// The emulator needs no credentials: plain fetch, no Authorization header.
const noAuth = {
  universeDomain: "googleapis.com",
  getRequestHeaders: async () => ({}),
  fetch: (url: string, init?: RequestInit) =>
    fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }),
};

export const createJobsClient = (
  env: Record<string, string | undefined>,
): JobsClient => {
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
