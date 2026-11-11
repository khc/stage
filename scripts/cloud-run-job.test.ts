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
      "hello",
    ),
  ).toEqual([
    { name: "AGENT_MESSAGE", value: "hello" },
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
      "hi",
    ),
  ).toEqual([
    { name: "AGENT_MESSAGE", value: "hi" },
    { name: "GOOGLE_CLOUD_PROJECT", value: "p" },
    { name: "FIRESTORE_EMULATOR_HOST", value: "emulator:4588" },
    { name: "GEMINI_API_KEY", value: "test-key" },
  ]);
});

test("rejects missing credentials before sending a job request", () => {
  expect(() => jobEnvironment({}, "p", "hi")).toThrow(
    "GEMINI_API_KEY is required",
  );
});

test("create and update send configured job resources without printing credentials", async () => {
  const requests: { method: string; url: URL; body: any }[] = [];
  const key = "test-secret-key";
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
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
      expect(container.env).toContainEqual({
        name: "AGENT_MESSAGE",
        value: 'hello "world"\nnext line',
      });
    }
  } finally {
    server.stop(true);
  }
});
