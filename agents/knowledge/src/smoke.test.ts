import { expect, test } from "bun:test";

import { smokeFailures } from "./smoke";

const reply = JSON.stringify({ answer: "Use Bun.file().", sources: ["bun › a.mdx › A"] });

test("a run that searched, found hits and replied with sources passes", () => {
  expect(smokeFailures({ searched: true, hits: 3, reply })).toEqual([]);
});

test("a run that never searched fails", () => {
  expect(smokeFailures({ searched: false, hits: undefined, reply })).toContain(
    "the agent never called search_knowledge_base",
  );
});

test("a search that failed or found nothing fails even when the reply is valid", () => {
  const empty = JSON.stringify({ answer: "I cannot reach the knowledge base.", sources: [] });
  expect(smokeFailures({ searched: true, hits: undefined, reply: empty })).toEqual([
    "search_knowledge_base returned an error or no hits",
    "the reply has no sources",
  ]);
  expect(smokeFailures({ searched: true, hits: 0, reply })).toEqual([
    "search_knowledge_base returned an error or no hits",
  ]);
});

test("a reply that is not a valid { answer, sources } object fails", () => {
  expect(smokeFailures({ searched: true, hits: 2, reply: "not json" })).toEqual([
    "the final reply is not a valid { answer, sources } object",
  ]);
  expect(
    smokeFailures({ searched: true, hits: 2, reply: '{"answer":"  ","sources":["x"]}' }),
  ).toEqual(["the final reply is not a valid { answer, sources } object"]);
});
