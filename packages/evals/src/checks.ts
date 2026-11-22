import type { ToolCall, Turn } from "./trace";

export type Expect = {
  // Exactly these tools, in this order.
  tools?: string[];
  toolsInclude?: string[];
  toolsExclude?: string[];
  // Agents the orchestrator called: every one listed / at least one listed.
  delegatedTo?: string[];
  delegatedToOneOf?: string[];
  // For each entry, at least one call of `tool` for which `match` holds. `match` gets the whole call,
  // so it can read the arguments and the response (a tool's refusal is in its response).
  calls?: { tool: string; description: string; match: (call: ToolCall) => boolean }[];
  // Rules that no other field states; returns one message per broken rule.
  custom?: (turn: Turn) => string[];
  answerIncludes?: string[];
  answerMatches?: RegExp;
  maxCalls?: Record<string, number>;
};

const AGENT_SEPARATOR = "__";
const list = (items: string[]) => (items.length ? items.join(", ") : "none");

// The orchestrator's tool for an agent is `<jobName>__<agentName>`.
const delegatedAgents = (turn: Turn) =>
  turn.toolCalls
    .filter((call) => call.name.includes(AGENT_SEPARATOR))
    .map((call) => call.name.split(AGENT_SEPARATOR).at(-1)!);

// One message per failed check; empty means the turn passes.
export const checkTurn = (turn: Turn, expect: Expect): string[] => {
  const failures: string[] = [];
  const names = turn.toolCalls.map((call) => call.name);
  const agents = delegatedAgents(turn);

  if (turn.run.status === "failed") {
    // The run's own error is generic; the cause (a model quota, say) is on the event that failed.
    const failed = turn.events.find((event) => event.errorMessage);
    const cause = failed ? ` (${failed.errorCode ?? "error"}: ${failed.errorMessage})` : "";
    failures.push(`run failed: ${turn.run.error ?? "no error"}${cause}`);
  }

  if (expect.tools && expect.tools.join() !== names.join())
    failures.push(`tools: expected [${list(expect.tools)}], got [${list(names)}]`);
  for (const tool of expect.toolsInclude ?? [])
    if (!names.includes(tool))
      failures.push(`toolsInclude: ${tool} was not called (called: ${list(names)})`);
  for (const tool of expect.toolsExclude ?? [])
    if (names.includes(tool))
      failures.push(`toolsExclude: ${tool} was called (called: ${list(names)})`);

  for (const agent of expect.delegatedTo ?? [])
    if (!agents.includes(agent))
      failures.push(`delegatedTo: expected ${agent}, delegated to [${list(agents)}]`);
  if (expect.delegatedToOneOf && !expect.delegatedToOneOf.some((agent) => agents.includes(agent)))
    failures.push(
      `delegatedToOneOf: expected one of [${list(expect.delegatedToOneOf)}], delegated to [${list(agents)}]`,
    );

  for (const { tool, description, match } of expect.calls ?? [])
    if (!turn.toolCalls.some((call) => call.name === tool && match(call)))
      failures.push(
        `calls: no ${tool} call ${description} (${tool} calls: ${JSON.stringify(turn.toolCalls.filter((c) => c.name === tool))})`,
      );

  for (const [tool, max] of Object.entries(expect.maxCalls ?? {})) {
    const count = names.filter((name) => name === tool).length;
    if (count > max) failures.push(`maxCalls: ${tool} was called ${count} times, at most ${max}`);
  }

  for (const text of expect.answerIncludes ?? [])
    if (!turn.answer.toLowerCase().includes(text.toLowerCase()))
      failures.push(
        `answerIncludes: "${text}" is not in the answer: ${JSON.stringify(turn.answer)}`,
      );
  if (expect.answerMatches && !expect.answerMatches.test(turn.answer))
    failures.push(
      `answerMatches: ${expect.answerMatches} does not match: ${JSON.stringify(turn.answer)}`,
    );

  return [...failures, ...(expect.custom?.(turn) ?? [])];
};
