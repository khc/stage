import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const workspace of ["service", "web"]) {
  test(`${workspace} start/dev scripts load the repository-root env from the workspace directory`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-env-"));
    try {
      const cwd = join(root, "apps", workspace);
      await mkdir(join(cwd, "src"), { recursive: true });
      await Bun.write(
        join(root, ".env"),
        "GCP_PROJECT=test-project\nGCP_REGION=test-region\nSERVICE_URL=http://localhost:4321\n",
      );
      await Bun.write(
        join(cwd, "src/index.ts"),
        "console.log(JSON.stringify({ project: process.env.GCP_PROJECT, region: process.env.GCP_REGION, service: process.env.SERVICE_URL }));",
      );
      const pkg = await Bun.file(
        new URL(`../apps/${workspace}/package.json`, import.meta.url),
      ).json();
      for (const name of ["start", "dev"]) {
        // The watch flag does not affect env loading; omit it so the fixture exits.
        const args = (pkg.scripts[name] as string)
          .split(/\s+/)
          .filter((arg) => arg !== "--hot");
        const child = Bun.spawn(args, {
          cwd,
          env: {
            ...process.env,
            GCP_PROJECT: undefined,
            GCP_REGION: undefined,
            SERVICE_URL: undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          project: "test-project",
          region: "test-region",
          service: "http://localhost:4321",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
