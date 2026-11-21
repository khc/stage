// Dependency check CLI built with listr2.
// Run: bun scripts/check-deps-listr2.ts

import { Listr, PRESET_TIMER, color } from "listr2";

import {
  checkDependency,
  createSpawnRunner,
  dependencySpecs,
  summarizeFailures,
  type DependencyResult,
} from "./check-deps.ts";

type CheckContext = {
  results: DependencyResult[];
};

const run = createSpawnRunner();

const tasks = new Listr<CheckContext>(
  dependencySpecs.map((spec) => ({
    title: spec.name,
    task: async (ctx, task) => {
      const result = await checkDependency(spec, run);
      ctx.results.push(result);

      if (!result.ok) {
        if (!spec.required) {
          task.skip(result.error ?? "optional dependency missing");
          return;
        }
        throw new Error(result.error ?? "check failed");
      }

      task.title = `${spec.name} ${color.dim(`(${result.version})`)}`;
    },
  })),
  {
    concurrent: true,
    exitOnError: false,
    rendererOptions: {
      collapseErrors: false,
      timer: PRESET_TIMER,
    },
  },
);

const ctx = await tasks.run({ results: [] });
const failed = ctx.results.filter((r) => !r.ok);

console.log();
if (failed.length > 0) {
  console.log(color.yellow("How to fix:"));
  console.log(summarizeFailures(failed).join("\n\n"));

  const requiredFailed = failed.filter((r) => r.spec.required);
  if (requiredFailed.length > 0) {
    console.error(color.red(`\n${requiredFailed.length} required check(s) failed.`));
    process.exitCode = 1;
  }
} else {
  console.log(color.green(`All ${ctx.results.length} checks passed.`));
}
