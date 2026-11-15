import type { Session } from "@google/adk";

export type SessionStats = {
  events: number;
  llmCalls: number;
  tokens: {
    prompt: number;
    candidates: number;
    thoughts: number;
    toolUsePrompt: number;
    cached: number;
    total: number;
  };
};

const count = (value: number | undefined) => value ?? 0;

// Sums the model usage ADK records on each event. `cached` is part of
// `prompt`, and `total` is the model-reported total, which also covers
// thoughts and tool-use prompt tokens.
export const sessionStats = ({ events }: Pick<Session, "events">): SessionStats => {
  const stats: SessionStats = {
    events: events.length,
    llmCalls: 0,
    tokens: {
      prompt: 0,
      candidates: 0,
      thoughts: 0,
      toolUsePrompt: 0,
      cached: 0,
      total: 0,
    },
  };
  for (const { usageMetadata: usage } of events) {
    if (!usage) continue;
    stats.llmCalls++;
    stats.tokens.prompt += count(usage.promptTokenCount);
    stats.tokens.candidates += count(usage.candidatesTokenCount);
    stats.tokens.thoughts += count(usage.thoughtsTokenCount);
    stats.tokens.toolUsePrompt += count(usage.toolUsePromptTokenCount);
    stats.tokens.cached += count(usage.cachedContentTokenCount);
    stats.tokens.total += count(usage.totalTokenCount);
  }
  return stats;
};
