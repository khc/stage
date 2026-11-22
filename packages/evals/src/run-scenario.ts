import type { EvalApi, ModelRef, RunMode } from "./api-client";
import type { Expect } from "./checks";
import { toTurn, type EvalEvent, type Trace, type Turn } from "./trace";

// A saved provider, by name, and one of its models.
export type ModelChoice = { provider: string; model: string };

export type Scenario = {
  name: string;
  // The agent app of `agents/<app>` and the agent in it.
  app: string;
  agent: string;
  // Defaults to quick: it is faster and starts no job.
  mode?: RunMode;
  // The task's default model; without one the job's default applies. `RunOptions.model` wins.
  model?: ModelChoice;
  turns: { say: string; expect: Expect }[];
  repeat?: number;
  minPassRate?: number;
};

export type RunOptions = {
  // How long to wait for a run to be accepted and to end.
  timeoutMs: number;
  pollMs: number;
  // How long the stream may lag behind the stored events once the run has ended.
  drainMs: number;
  keep: boolean;
  env: string;
  model?: ModelChoice;
};

// Every task an eval creates is named with it, so leftovers are easy to find and delete.
export const EVAL_TASK_PREFIX = "eval:";

// `stage--<app>-agents--job-<env>` (docs/naming-rules.md).
export const jobNameFor = (app: string, env: string) => `stage--${app}-agents--job-${env}`;

const resolveModel = async (api: EvalApi, choice: ModelChoice): Promise<ModelRef> => {
  const providers = await api.listProviders();
  const matches = providers.filter((p) => p.name.toLowerCase() === choice.provider.toLowerCase());
  if (matches.length > 1)
    throw new Error(
      `model provider "${choice.provider}" is ambiguous: ${matches.length} saved providers have that name`,
    );
  const [found] = matches;
  if (!found)
    throw new Error(
      `model provider "${choice.provider}" not found; saved providers: ${providers.map((p) => p.name).join(", ")}`,
    );
  return { providerId: found.providerId, model: choice.model };
};

const RETRYABLE = new Set(["run_in_progress", "message_pending"]);

const until = async <T>(what: string, options: RunOptions, poll: () => Promise<T | undefined>) => {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(options.pollMs);
  }
};

// Plays one message: sends it, follows the stream, waits for the run to end, and returns the events
// the message added, in the session's stored order.
const runTurn = async (
  api: EvalApi,
  scenario: Scenario,
  options: RunOptions,
  state: { taskId: string; sessionId?: string },
  message: string,
): Promise<Turn> => {
  const { taskId } = state;
  const before = state.sessionId ? await api.getSession(taskId, state.sessionId) : undefined;
  const seen = new Set(before?.events.flatMap((e) => (e.id ? [e.id] : [])));
  const previousStartedAt = before?.run?.startedAt;

  const accepted = await until("the run to be accepted", options, async () => {
    const result = await api.run(taskId, {
      message,
      mode: scenario.mode ?? "quick",
      ...(state.sessionId && { sessionId: state.sessionId }),
    });
    if (result.status === 202) return result;
    if (!RETRYABLE.has(result.error)) throw new Error(`run rejected: ${result.error}`);
    return undefined;
  });
  state.sessionId ??= accepted.sessionId;
  const { sessionId } = state;
  if (!sessionId) throw new Error("the run returned no sessionId");

  // The stream replays every stored event and then adds live ones, so earlier turns' events come
  // through it too; they are told apart by id.
  const streamed = new Map<string, EvalEvent>();
  const controller = new AbortController();
  let streamError: unknown;
  const pump = (async () => {
    try {
      for await (const event of api.streamEvents(taskId, sessionId, controller.signal))
        if (event.id && !seen.has(event.id)) streamed.set(event.id, event);
    } catch (err) {
      if (!controller.signal.aborted) streamError = err;
    }
  })();

  try {
    const run = await until("the run to end", options, async () => {
      const view = await api.getSession(taskId, sessionId);
      const current = view.run;
      return current && current.startedAt !== previousStartedAt && current.status !== "running"
        ? current
        : undefined;
    });
    const stored = await drain(
      api,
      options,
      { taskId, sessionId },
      seen,
      streamed,
      () => streamError,
    );
    const storedIds = new Set(stored.map((e) => e.id));
    const extras = [...streamed.values()].filter((e) => !storedIds.has(e.id));
    return toTurn(message, [...stored.map((e) => streamed.get(e.id!)!), ...extras], run);
  } finally {
    controller.abort();
    await pump;
  }
};

// Waits until the stream has delivered every event the run stored; the stored list is the truth.
const drain = async (
  api: EvalApi,
  options: RunOptions,
  { taskId, sessionId }: { taskId: string; sessionId: string },
  seen: Set<string>,
  streamed: Map<string, EvalEvent>,
  streamError: () => unknown,
) => {
  const deadline = Date.now() + options.drainMs;
  for (;;) {
    if (streamError()) throw new Error(`stream_failed: ${String(streamError())}`);
    const view = await api.getSession(taskId, sessionId);
    const stored = view.events.filter((e) => e.id && !seen.has(e.id));
    const missing = stored.filter((e) => !streamed.has(e.id!));
    if (!missing.length) return stored;
    if (Date.now() >= deadline)
      throw new Error(
        `sse_incomplete: the stream is missing ${missing.map((e) => e.id).join(", ")}`,
      );
    await Bun.sleep(options.pollMs);
  }
};

// Creates a task on the agent and plays each turn on one session. A failed run ends the scenario
// there, so its trace has fewer turns. The task is deleted afterwards unless `keep` is set.
export const runScenario = async (
  api: EvalApi,
  scenario: Scenario,
  options: RunOptions,
): Promise<Trace> => {
  const first = scenario.turns[0];
  if (!first) throw new Error(`scenario ${scenario.name} has no turns`);
  const choice = options.model ?? scenario.model;
  const defaultModel = choice && (await resolveModel(api, choice));
  const { taskId } = await api.createTask({
    name: `${EVAL_TASK_PREFIX} ${scenario.name} (${crypto.randomUUID().slice(0, 8)})`,
    prompt: first.say,
    jobName: jobNameFor(scenario.app, options.env),
    agentName: scenario.agent,
    ...(defaultModel && { defaultModel }),
  });
  try {
    const state: { taskId: string; sessionId?: string } = { taskId };
    const turns: Turn[] = [];
    for (const { say } of scenario.turns) {
      const turn = await runTurn(api, scenario, options, state, say);
      turns.push(turn);
      if (turn.run.status === "failed") break;
    }
    return { taskId, sessionId: state.sessionId ?? "", turns };
  } finally {
    if (!options.keep)
      await api
        .deleteTask(taskId)
        .catch((err) => console.warn(`could not delete task ${taskId}:`, err));
  }
};
