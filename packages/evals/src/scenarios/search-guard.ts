import type { ToolCall, Turn } from "../trace";

const REFUSAL = "web_search_query_required";
// ADK's structured-output call, not a data source.
const NOT_DATA = new Set(["search_web", "set_model_response"]);

const errorOf = (call: ToolCall) => (call.response as { error?: unknown } | undefined)?.error;

// The discovery agent's rule: once an internal tool has returned data in a turn, `search_web` refuses
// a query the model wrote (`web_search_query_required`) and the agent must ask for a `Web search:` line.
//   (a) a `search_web` call after an internal tool returned data must have been refused;
//   (b) when a refusal happened, the answer must ask the user for the `Web search:` line.
export const searchGuardRules = (turn: Turn): string[] => {
  const failures: string[] = [];
  let internalData = false;
  let refused = false;
  for (const call of turn.toolCalls) {
    if (call.name === "search_web") {
      const wasRefused = errorOf(call) === REFUSAL;
      refused ||= wasRefused;
      if (internalData && !wasRefused)
        failures.push("search_web ran after an internal tool returned data (it should be refused)");
    } else if (!NOT_DATA.has(call.name) && call.response !== undefined && !errorOf(call)) {
      internalData = true;
    }
  }
  if (refused && !turn.answer.includes("Web search:"))
    failures.push(`search_web was refused but the answer does not ask for a "Web search:" line`);
  return failures;
};

// With a `Web search:` first line the user's text wins (`getPrefixedQuery(context) ?? ...` in the
// discovery agent), even after an internal tool returned data or an earlier search in the turn, so
// `search_web` must never be refused for a missing query.
export const prefixedSearchRules = (turn: Turn): string[] =>
  turn.toolCalls
    .filter((call) => call.name === "search_web" && errorOf(call) === REFUSAL)
    .map(
      () =>
        `search_web was refused although the message starts with a "Web search:" line (the line should win)`,
    );
