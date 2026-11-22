import { beforeAll, test } from "bun:test";

import { createApiClient, type EvalApi, type TaskSummary } from "./api-client";
import { checkTurn } from "./checks";
import {
  EVAL_TASK_PREFIX,
  runScenario,
  type ModelChoice,
  type RunOptions,
  type Scenario,
} from "./run-scenario";
import type { Trace } from "./trace";

const PER_TURN_TIMEOUT_MS = 120_000;

export type Settings = {
  serviceUrl: string;
  env: string;
  keep: boolean;
  clean: boolean;
  repeat: number | undefined;
  model: ModelChoice | undefined;
};

// "<provider name>/<model>", split at the first slash: a model id may hold slashes, a provider name may not.
const parseModel = (value: string | undefined): ModelChoice | undefined => {
  if (value === undefined) return undefined;
  const slash = value.indexOf("/");
  const provider = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  if (slash < 1 || !provider || !model)
    throw new Error(`EVAL_MODEL must be "<provider name>/<model>", got "${value}"`);
  return { provider, model };
};

export const readSettings = (env: Record<string, string | undefined>): Settings => {
  const repeat = env.EVAL_REPEAT === undefined ? undefined : Number(env.EVAL_REPEAT);
  if (repeat !== undefined && !(Number.isInteger(repeat) && repeat > 0))
    throw new Error(`EVAL_REPEAT must be a positive integer, got "${env.EVAL_REPEAT}"`);
  return {
    serviceUrl: env.SERVICE_URL ?? "http://localhost:3000",
    env: env.EVAL_ENV ?? "lcl",
    keep: env.EVAL_KEEP === "1",
    clean: env.EVAL_CLEAN === "1",
    repeat,
    model: parseModel(env.EVAL_MODEL),
  };
};

export const passRate = (results: boolean[], min: number) => {
  const passes = results.filter(Boolean).length;
  return {
    passes,
    total: results.length,
    ok: results.length > 0 && passes / results.length >= min,
  };
};

// A top-level task a killed run, or `EVAL_KEEP`, left behind.
export const isEvalLeftover = (task: TaskSummary) =>
  !!task.name?.startsWith(EVAL_TASK_PREFIX) && !task.parentTaskId;

// The failures of one run: each turn's, and the turns a failed run never reached.
export const evaluate = (scenario: Scenario, trace: Trace): string[] =>
  scenario.turns.flatMap(({ expect }, index) => {
    const turn = trace.turns[index];
    if (!turn) return [`turn ${index + 1}: not run`];
    return checkTurn(turn, expect).map((failure) => `turn ${index + 1}: ${failure}`);
  });

const prepared = new WeakMap<EvalApi, Promise<void>>();

// Once per client: the service must answer, and with `EVAL_CLEAN=1` the leftovers are deleted.
const prepare = (api: EvalApi, settings: Settings) => {
  let ready = prepared.get(api);
  if (!ready) {
    ready = (async () => {
      await api.health().catch((err) => {
        throw new Error(`the service is not reachable at ${settings.serviceUrl}: ${String(err)}`);
      });
      if (settings.clean)
        for (const task of (await api.listTasks()).filter(isEvalLeftover))
          await api.deleteTask(task.taskId);
    })();
    prepared.set(api, ready);
  }
  return ready;
};

// Registers one `bun:test` test that runs the scenario `repeat` times and passes at `minPassRate`.
export const defineScenario = (scenario: Scenario, deps: { api?: EvalApi } = {}) => {
  const settings = readSettings(Bun.env);
  const api = deps.api ?? createApiClient(settings.serviceUrl);
  const repeat = settings.repeat ?? scenario.repeat ?? 1;
  const minPassRate = scenario.minPassRate ?? 1;
  const options: RunOptions = {
    timeoutMs: PER_TURN_TIMEOUT_MS,
    pollMs: 500,
    drainMs: 5_000,
    keep: settings.keep,
    env: settings.env,
    ...(settings.model && { model: settings.model }),
  };

  beforeAll(() => prepare(api, settings), PER_TURN_TIMEOUT_MS);

  test(
    scenario.name,
    async () => {
      const runs: { ok: boolean; failures: string[] }[] = [];
      for (let index = 1; index <= repeat; index++) {
        try {
          const trace = await runScenario(api, scenario, options);
          const failures = evaluate(scenario, trace);
          runs.push({
            ok: failures.length === 0,
            failures: failures.map((failure) => `run ${index} (task ${trace.taskId}): ${failure}`),
          });
        } catch (err) {
          runs.push({ ok: false, failures: [`run ${index}: ${String(err)}`] });
        }
      }
      const { passes, total, ok } = passRate(
        runs.map((run) => run.ok),
        minPassRate,
      );
      console.log(`${scenario.name}: ${passes}/${total} runs passed (need ${minPassRate})`);
      if (!ok)
        throw new Error(
          `${passes}/${total} runs passed, need ${minPassRate}:\n${runs.flatMap((run) => run.failures).join("\n")}`,
        );
    },
    repeat * scenario.turns.length * PER_TURN_TIMEOUT_MS,
  );
};
