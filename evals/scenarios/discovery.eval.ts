import { defineScenario } from "@stage/evals/scenario";
import type { ToolCall } from "@stage/evals/trace";

import { prefixedSearchRules, searchGuardRules } from "./search-guard";

const app = "knowledge";
const agent = "discovery-assistant";
// The saved provider "Inception Labs"; the Vertex AI default model hits its quota on a long run.
const model = { provider: "Inception Labs", model: "mercury-3" };

const searchQuery = (call: ToolCall) => (call.args as { query?: string } | undefined)?.query ?? "";

// IMDb first: the actress comes from the internal sources; only the follow-up goes to the web.
// Turn 1 names one character so that "she" in turn 2 is not ambiguous.
defineScenario({
  name: "discovery: imdb first, then web search",
  app,
  agent,
  model,
  repeat: 1,
  minPassRate: 0.8,
  turns: [
    {
      say: "Who plays Rachel Green in Friends?",
      expect: {
        toolsInclude: ["discover_assets"],
        toolsExclude: ["search_web"],
        answerIncludes: ["Aniston"],
      },
    },
    {
      say: "Where does she live?",
      expect: {
        toolsInclude: ["search_web"],
        maxCalls: { search_web: 1 },
        calls: [
          {
            tool: "search_web",
            description: "with a query that names Aniston (the pronoun resolved from turn 1)",
            match: (call) => /aniston/i.test(searchQuery(call)),
          },
        ],
      },
    },
  ],
});

// Once an internal tool has returned data, search_web refuses a model-written query and the agent
// must ask for a `Web search:` line instead of retrying.
defineScenario({
  name: "discovery: blocked search asks for a Web search line",
  app,
  agent,
  model,
  repeat: 1,
  minPassRate: 0.8,
  turns: [
    {
      say: "Who directed the 1995 film Heat, and what is the latest news about him?",
      expect: { maxCalls: { search_web: 1 }, custom: searchGuardRules },
    },
  ],
});

// A `Web search:` first line is honoured even where a model-written query would be refused. The
// second line invites an internal tool call before the search, the case the rule exists for; when
// the model searches first, the rule is met trivially and the repeats give the signal.
defineScenario({
  name: "discovery: a Web search line is honoured",
  app,
  agent,
  model,
  repeat: 5,
  minPassRate: 0.8,
  turns: [
    {
      say: "Web search: Jennifer Aniston residence\nAlso list two Friends episode titles she appeared in.",
      expect: { toolsInclude: ["search_web"], custom: prefixedSearchRules },
    },
  ],
});
