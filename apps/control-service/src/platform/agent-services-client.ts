import { RunInProgressError } from "@stage/agents/session-service";

import { withinSignal } from "./extract-client";

// The quick run did not finish within its budget: the service answered 504, or the client gave up.
export class QuickTimeoutError extends Error {
  constructor() {
    super("The quick run exceeded its time budget");
    this.name = "QuickTimeoutError";
  }
}

// The run started on the service and failed there; its session records the failure.
export class RunFailedError extends Error {
  constructor() {
    super("The run failed on the agent service");
    this.name = "RunFailedError";
  }
}

export type AgentServices = {
  // Whether the job has a quick service.
  has: (job: string) => boolean;
  // Runs the task on the job's service and resolves when it has finished. Throws RunInProgressError
  // when the session is leased and QuickTimeoutError when the budget runs out.
  run: (job: string, taskId: string, sessionId?: string) => Promise<void>;
};

export type AgentServicesOptions = {
  // Makes the Authorization header source for an audience (the service URL), for authenticated
  // services (see id-token.ts); made once per job.
  authorization?: (audience: string) => () => Promise<string>;
  // The budget of one quick run; the service is told the same and stops the run at it.
  timeoutMs: number;
};

// `urls` maps a job name to the base URL of its agent service.
export const createAgentServices = (
  urls: Record<string, string>,
  { authorization, timeoutMs }: AgentServicesOptions,
): AgentServices => {
  // The ID token goes only over https, to the configured URL.
  if (authorization)
    for (const [job, url] of Object.entries(urls))
      if (!url.startsWith("https://"))
        throw new Error(`An ID token is sent only over https: ${job} is ${url}`);
  const headerSources = new Map<string, () => Promise<string>>();
  const headerSource = (job: string, url: string) => {
    if (!authorization) return undefined;
    let source = headerSources.get(job);
    if (!source) headerSources.set(job, (source = authorization(url)));
    return source;
  };
  return {
    has: (job) => Object.hasOwn(urls, job),
    async run(job, taskId, sessionId) {
      const url = urls[job];
      if (!url) throw new Error(`No agent service for the job ${job}`);
      const signal = AbortSignal.timeout(timeoutMs);
      const source = headerSource(job, url);
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/run`, {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(source && { authorization: await withinSignal(source(), signal) }),
          },
          body: JSON.stringify({ taskId, sessionId, budgetMs: timeoutMs }),
        });
        if (res.status === 409) throw new RunInProgressError();
        if (res.status === 504) throw new QuickTimeoutError();
        if (res.status === 500 && (await res.json().catch(() => undefined))?.error === "run_failed")
          throw new RunFailedError();
        if (!res.ok) throw new Error(`agent service failed: HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError")
          throw new QuickTimeoutError();
        throw err;
      }
    },
  };
};
