import { expect, test } from "bun:test";

import { evaluateQuery, matches, rankDocs, summarize, type JudgedQuery } from "./evaluation";
import type { SearchHit } from "./platform/qdrant-client";

const hit = (docId: string): SearchHit => ({ id: docId, score: 1, payload: { doc_id: docId } });

test("a pattern is an exact document id, or a prefix when it ends in *", () => {
  expect(matches("bun:a.mdx", "bun:a.mdx")).toBe(true);
  expect(matches("bun:a.mdx", "bun:a.mdx.bak")).toBe(false);
  expect(matches("bun:guides/http/*", "bun:guides/http/simple.mdx")).toBe(true);
  expect(matches("bun:guides/http/*", "bun:guides/httpx/a.mdx")).toBe(false);
});

test("chunk hits become documents in order of first appearance", () => {
  expect(rankDocs([hit("a"), hit("b"), hit("a"), hit("c"), hit("b")])).toEqual(["a", "b", "c"]);
});

test("the best rank is the position of the first acceptable document", () => {
  const judged: JudgedQuery = { query: "q", relevant: ["bun:guides/*", "bun:x.mdx"] };
  const docs = ["bun:y.mdx", "bun:z.mdx", "bun:guides/a.mdx", "bun:x.mdx"];
  expect(evaluateQuery(judged, docs, 5)).toEqual({ query: "q", bestRank: 3, hit: true });
  expect(evaluateQuery(judged, docs, 2)).toEqual({ query: "q", bestRank: 3, hit: false });
  expect(evaluateQuery(judged, ["bun:y.mdx"], 5)).toEqual({
    query: "q",
    bestRank: undefined,
    hit: false,
  });
});

test("recall@k counts queries with a hit, and MRR counts a miss as zero", () => {
  const results = [
    { query: "a", bestRank: 1, hit: true },
    { query: "b", bestRank: 4, hit: true },
    { query: "c", bestRank: 9, hit: false },
    { query: "d", bestRank: undefined, hit: false },
  ];
  expect(summarize(results)).toEqual({
    queries: 4,
    hits: 2,
    recall: 0.5,
    mrr: (1 + 1 / 4 + 1 / 9 + 0) / 4,
    notFound: 1,
  });
  expect(summarize([])).toEqual({ queries: 0, hits: 0, recall: 0, mrr: 0, notFound: 0 });
});

test("the judged set has distinct queries with acceptable documents of a known source", async () => {
  const set = (await Bun.file(`${import.meta.dir}/../eval/queries.json`).json()) as JudgedQuery[];
  expect(set.length).toBeGreaterThanOrEqual(10);
  expect(new Set(set.map((q) => q.query)).size).toBe(set.length);
  for (const { query, relevant } of set) {
    expect(query.trim()).not.toBe("");
    expect(relevant.length).toBeGreaterThan(0);
    for (const pattern of relevant) expect(pattern).toMatch(/^(bun|duckdb):\S+$/);
  }
});
