import { expect, test } from "bun:test";
import { jobEnvironment } from "./cloud-run-job";

test("supplies the job with Firestore configuration and model credentials", () => {
  expect(
    jobEnvironment(
      {
        GEMINI_API_KEY: "test-key",
        AGENT_MODEL: "test-model",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
      },
      "p",
    ),
  ).toEqual([
    { name: "GOOGLE_CLOUD_PROJECT", value: "p" },
    { name: "FIRESTORE_EMULATOR_HOST", value: "floci-gcp:4588" },
    { name: "GEMINI_API_KEY", value: "test-key" },
    { name: "AGENT_MODEL", value: "test-model" },
    { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
  ]);
});

test("supports a custom job-visible emulator host and omits absent optional settings", () => {
  expect(
    jobEnvironment(
      {
        GEMINI_API_KEY: "test-key",
        JOB_FIRESTORE_EMULATOR_HOST: "emulator:4588",
      },
      "p",
    ),
  ).toEqual([
    { name: "GOOGLE_CLOUD_PROJECT", value: "p" },
    { name: "FIRESTORE_EMULATOR_HOST", value: "emulator:4588" },
    { name: "GEMINI_API_KEY", value: "test-key" },
  ]);
});

test("rejects missing credentials before sending a job request", () => {
  expect(() => jobEnvironment({}, "p")).toThrow("GEMINI_API_KEY is required");
});

test("create and update send configured job resources without printing credentials", async () => {
  const requests: { method: string; url: URL; body: any }[] = [];
  const key = "test-secret-key";
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET")
        return Response.json({ template: { template: { containers: [{}] } } });
      const body = await req.json();
      requests.push({ method: req.method, url: new URL(req.url), body });
      return Response.json(body);
    },
  });
  try {
    for (const mode of ["create", "update"]) {
      const child = Bun.spawn(["bun", "scripts/cloud-run-job.ts", mode], {
        env: {
          ...process.env,
          JOB_FLOCI: `http://localhost:${server.port}`,
          JOB_PROJECT: "p",
          JOB_REGION: "l",
          JOB_NAME: "test-job",
          JOB_IMAGE: "test-image",
          JOB_MESSAGE: 'hello "world"\nnext line',
          GEMINI_API_KEY: key,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("projects/p/locations/l/jobs/test-job");
      expect(stdout + stderr).not.toContain(key);
    }
    expect(requests.map((r) => r.method)).toEqual(["POST", "PATCH"]);
    expect(requests[0]!.url.pathname).toBe("/v2/projects/p/locations/l/jobs");
    expect(requests[0]!.url.searchParams.get("jobId")).toBe("test-job");
    expect(requests[1]!.url.pathname).toBe(
      "/v2/projects/p/locations/l/jobs/test-job",
    );
    expect(requests[1]!.url.searchParams.get("updateMask")).toBe("template");
    expect(requests[1]!.body.name).toBe("projects/p/locations/l/jobs/test-job");
    for (const { body } of requests) {
      const container = body.template.template.containers[0];
      expect(container.image).toBe("test-image");
      expect(container.env).toContainEqual({
        name: "GEMINI_API_KEY",
        value: key,
      });
      expect(
        container.env.some((entry: { name: string }) =>
          ["AGENT_MESSAGE", "RUN_ID"].includes(entry.name),
        ),
      ).toBe(false);
    }
  } finally {
    server.stop(true);
  }
});

test("update preserves the existing template and merges the agent environment", async () => {
  const template = {
    taskCount: 2,
    parallelism: 1,
    labels: { team: "agent" },
    template: {
      timeout: "120s",
      maxRetries: 0,
      serviceAccount: "agent@example.test",
      volumes: [{ name: "scratch", emptyDir: {} }],
      containers: [
        {
          name: "agent",
          image: "old-image",
          command: ["bun"],
          args: ["custom.ts"],
          resources: { limits: { cpu: "1", memory: "512Mi" } },
          volumeMounts: [{ name: "scratch", mountPath: "/scratch" }],
          env: [
            { name: "CUSTOM_SETTING", value: "keep" },
            { name: "AGENT_MESSAGE", value: "legacy message" },
            { name: "RUN_ID", value: "legacy-id" },
            {
              name: "GEMINI_API_KEY",
              valueSource: {
                secretKeyRef: { secret: "old-secret", version: "latest" },
              },
            },
          ],
        },
        {
          name: "sidecar",
          image: "sidecar-image",
          env: [{ name: "SIDECAR_SETTING", value: "keep" }],
        },
      ],
    },
  };
  const requests: string[] = [];
  let patched: any;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(req.method);
      if (req.method === "GET") return Response.json({ template });
      patched = await req.json();
      return Response.json(patched);
    },
  });
  try {
    const child = Bun.spawn(["bun", "scripts/cloud-run-job.ts", "update"], {
      env: {
        ...process.env,
        JOB_FLOCI: `http://localhost:${server.port}`,
        JOB_PROJECT: "p",
        JOB_REGION: "l",
        JOB_NAME: "test-job",
        JOB_IMAGE: "new-image",
        JOB_MESSAGE: "new message",
        GEMINI_API_KEY: "new-key",
        AGENT_MODEL: "",
        GOOGLE_GENAI_USE_VERTEXAI: "",
        JOB_FIRESTORE_EMULATOR_HOST: "floci-gcp:4588",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout + stderr).not.toContain("new-key");
    expect(requests).toEqual(["GET", "PATCH"]);
    expect(patched.template).toEqual({
      ...template,
      template: {
        ...template.template,
        containers: [
          {
            ...template.template.containers[0],
            image: "new-image",
            env: [
              { name: "CUSTOM_SETTING", value: "keep" },
              { name: "GOOGLE_CLOUD_PROJECT", value: "p" },
              { name: "FIRESTORE_EMULATOR_HOST", value: "floci-gcp:4588" },
              { name: "GEMINI_API_KEY", value: "new-key" },
            ],
          },
          template.template.containers[1],
        ],
      },
    });
  } finally {
    server.stop(true);
  }
});

test("update stops without patching when the existing job cannot be read", async () => {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      methods.push(req.method);
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const child = Bun.spawn(["bun", "scripts/cloud-run-job.ts", "update"], {
      env: {
        ...process.env,
        JOB_FLOCI: `http://localhost:${server.port}`,
        GEMINI_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cloud Run job read failed: HTTP 404");
    expect(methods).toEqual(["GET"]);
  } finally {
    server.stop(true);
  }
});
