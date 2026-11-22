// One part of an ADK event as the session API serves it (the fields the evals read).
export type EvalPart = {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
};

export type EvalEvent = {
  id?: string;
  invocationId?: string;
  author?: string;
  errorCode?: string;
  errorMessage?: string;
  content?: { role?: string; parts?: EvalPart[] };
};

export type RunSummary = {
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  error?: string;
};

export type ToolCall = { name: string; args: unknown; response?: unknown };

export type Turn = {
  message: string;
  events: EvalEvent[];
  toolCalls: ToolCall[];
  answer: string;
  run: RunSummary;
};

export type Trace = { taskId: string; sessionId: string; turns: Turn[] };

const parts = (event: EvalEvent) => event.content?.parts ?? [];

// Each function call in order, with the first still unanswered response of the same name attached.
export const toolCalls = (events: EvalEvent[]): ToolCall[] => {
  const calls: ToolCall[] = [];
  const unanswered = new Map<string, ToolCall[]>();
  for (const part of events.flatMap(parts)) {
    const { functionCall, functionResponse } = part;
    if (functionCall?.name) {
      const call: ToolCall = { name: functionCall.name, args: functionCall.args };
      calls.push(call);
      unanswered.set(call.name, [...(unanswered.get(call.name) ?? []), call]);
    }
    if (functionResponse?.name) {
      const call = unanswered.get(functionResponse.name)?.shift();
      if (call) call.response = functionResponse.response;
    }
  }
  return calls;
};

// The agents that return `{answer, sources}` put it in the text as JSON; the answer is the text then.
const unwrap = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && "answer" in value && typeof value.answer === "string")
      return value.answer;
  } catch {
    // Not JSON: plain text is the answer.
  }
  return text;
};

// The text of the last model event that has any, without thought parts.
export const finalAnswer = (events: EvalEvent[]): string => {
  for (const event of events.toReversed()) {
    if (event.content?.role !== "model") continue;
    const text = parts(event)
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text) return unwrap(text);
  }
  return "";
};

export const toTurn = (message: string, events: EvalEvent[], run: RunSummary): Turn => ({
  message,
  events,
  toolCalls: toolCalls(events),
  answer: finalAnswer(events),
  run,
});
