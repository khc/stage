// Manual live check, not part of `bun test`: runs knowledgeAgent with the real model, embedding
// server and Qdrant (`bun run --filter @stage/knowledge-agents smoke "<question>"`) and exits
// non-zero unless the agent searched, the search returned hits and its final reply is a valid
// { answer, sources } object with sources.
import {
  InMemoryRunner,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  stringifyContent,
} from "@google/adk";

import { knowledgeAgent, knowledgeOutput } from "./agents";

const TOOL = "search_knowledge_base";

export type SmokeRun = {
  searched: boolean;
  // Hits of the search tool's last response; undefined when it answered with an error.
  hits: number | undefined;
  reply: string;
};

export const smokeFailures = ({ searched, hits, reply }: SmokeRun): string[] => {
  const failures: string[] = [];
  if (!searched) failures.push(`the agent never called ${TOOL}`);
  else if (!hits) failures.push(`${TOOL} returned an error or no hits`);
  const parsed = (() => {
    try {
      return knowledgeOutput.safeParse(JSON.parse(reply));
    } catch {
      return undefined;
    }
  })();
  if (!parsed?.success || !parsed.data.answer.trim()) {
    failures.push("the final reply is not a valid { answer, sources } object");
  } else if (parsed.data.sources.length === 0) {
    failures.push("the reply has no sources");
  }
  return failures;
};

const run = async (question: string): Promise<SmokeRun> => {
  const runner = new InMemoryRunner({ agent: knowledgeAgent, appName: "knowledge-smoke" });
  const session = await runner.sessionService.createSession({
    appName: "knowledge-smoke",
    userId: "smoke",
  });

  const result: SmokeRun = { searched: false, hits: undefined, reply: "" };
  for await (const event of runner.runAsync({
    userId: "smoke",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: question }] },
  })) {
    for (const call of getFunctionCalls(event)) {
      result.searched ||= call.name === TOOL;
      console.log(`tool call: ${call.name} ${JSON.stringify(call.args)}`);
    }
    for (const response of getFunctionResponses(event)) {
      if (response.name !== TOOL) continue;
      const hits = (response.response as { hits?: unknown[] } | undefined)?.hits;
      result.hits = Array.isArray(hits) ? hits.length : undefined;
    }
    if (isFinalResponse(event) && event.content?.parts?.length) {
      result.reply = stringifyContent(event).trim();
    }
  }
  return result;
};

if (import.meta.main) {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('usage: bun run smoke "<question>"');
    process.exit(2);
  }
  const result = await run(question);
  console.log(`final reply: ${result.reply}`);
  const failures = smokeFailures(result);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
