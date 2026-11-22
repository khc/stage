import { defineScenario } from "@stage/evals/scenario";

// A question both IMDb-capable agents can answer, so either is a correct route. The 1995 film is
// named because the IMDb data holds many titles called "Heat".
defineScenario({
  name: "orchestrator: routes an IMDb question to an IMDb agent",
  app: "orchestrator",
  agent: "orchestrator",
  turns: [
    {
      say: "Who directed the 1995 film Heat?",
      expect: {
        delegatedToOneOf: ["imdb-assistant", "discovery-assistant"],
        answerIncludes: ["Michael Mann"],
      },
    },
  ],
});
