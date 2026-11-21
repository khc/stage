// Dependency check CLI built with @clack/prompts.
// Run: bun scripts/check-deps-clack.ts

import { intro, log, note, outro, spinner } from "@clack/prompts";

import {
  checkDependency,
  createSpawnRunner,
  dependencySpecs,
  summarizeFailures,
  type DependencyResult,
} from "./check-deps.ts";

const run = createSpawnRunner();
const results: DependencyResult[] = [];

intro("stage · dependency check (@clack/prompts)");

const s = spinner();
for (const spec of dependencySpecs) {
  s.start(`Checking ${spec.name}...`);
  const result = await checkDependency(spec, run);
  results.push(result);

  if (result.ok) {
    s.stop(`${spec.name} (${result.version})`);
  } else {
    s.error(`${spec.name} — ${result.error}`);
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  note(summarizeFailures(failed).join("\n\n"), "How to fix");
  const requiredFailed = failed.filter((r) => r.spec.required);
  if (requiredFailed.length > 0) {
    outro(`${requiredFailed.length} required check(s) failed`);
    process.exitCode = 1;
  } else {
    log.warn("Optional checks failed, required dependencies are ready.");
    outro("Ready with warnings");
  }
} else {
  outro(`All ${results.length} checks passed`);
}
