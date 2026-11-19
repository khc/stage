import type { SearchHit } from "./platform/qdrant-client";

// A question and the documents that answer it. Each entry of `relevant` is a document id, or a
// prefix when it ends in `*`; any one of them is a good answer.
export type JudgedQuery = { query: string; relevant: string[] };

export type QueryResult = {
  query: string;
  // 1-based position of the first acceptable document, undefined when none was retrieved.
  bestRank: number | undefined;
  hit: boolean;
};

export type Summary = {
  queries: number;
  hits: number;
  // Share of queries with an acceptable document in the top k.
  recall: number;
  // Mean of 1 / bestRank, a miss counting as 0.
  mrr: number;
  notFound: number;
};

export const matches = (pattern: string, docId: string) =>
  pattern.endsWith("*") ? docId.startsWith(pattern.slice(0, -1)) : docId === pattern;

// The documents of a chunk ranking, each at the position of its first chunk.
export const rankDocs = (hits: SearchHit[]) => [
  ...new Set(hits.map((hit) => String(hit.payload.doc_id))),
];

export const evaluateQuery = ({ query, relevant }: JudgedQuery, docs: string[], k: number) => {
  const index = docs.findIndex((doc) => relevant.some((pattern) => matches(pattern, doc)));
  const bestRank = index < 0 ? undefined : index + 1;
  return { query, bestRank, hit: bestRank !== undefined && bestRank <= k } satisfies QueryResult;
};

export const summarize = (results: QueryResult[]): Summary => {
  const hits = results.filter((result) => result.hit).length;
  const reciprocal = results.map((result) => (result.bestRank ? 1 / result.bestRank : 0));
  return {
    queries: results.length,
    hits,
    recall: results.length ? hits / results.length : 0,
    mrr: results.length ? reciprocal.reduce((a, b) => a + b, 0) / results.length : 0,
    notFound: results.filter((result) => result.bestRank === undefined).length,
  };
};
