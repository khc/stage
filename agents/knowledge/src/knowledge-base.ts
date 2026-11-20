import { loadConfig } from "@stage/ingestion/config";
import type { CorpusName } from "@stage/ingestion/corpora";
import { createEmbedder, type Embedder } from "@stage/ingestion/platform/embeddings-client";
import { createQdrantIndex, type VectorIndex } from "@stage/ingestion/platform/qdrant-client";

// Chunks returned per search.
const HITS = 5;

export type KnowledgeBase = {
  embedder: Pick<Embedder, "embedQuery">;
  vectorIndex: Pick<VectorIndex, "search">;
};

export type Hit = {
  score: number;
  source: string;
  docId: string;
  sectionPath: string;
  text: string;
};

export type SearchKnowledgeBase = (args: {
  query: string;
  source?: CorpusName;
}) => Promise<{ hits: Hit[] }>;

// Connects to the embedding server and the Qdrant collection the ingestion package filled.
export const openKnowledgeBase = async (
  env: Record<string, string | undefined>,
): Promise<KnowledgeBase> => {
  const config = loadConfig(env);
  if (!config.EMBEDDING_URL || !config.EMBEDDING_MODEL) {
    throw new Error("EMBEDDING_URL and EMBEDDING_MODEL are required to search the knowledge base");
  }
  const embedder = await createEmbedder(fetch, {
    url: config.EMBEDDING_URL,
    model: config.EMBEDDING_MODEL,
    apiKey: config.EMBEDDING_API_KEY || undefined,
    documentPrefix: config.EMBEDDING_DOCUMENT_PREFIX || undefined,
    queryPrefix: config.EMBEDDING_QUERY_PREFIX || undefined,
  });
  const vectorIndex = await createQdrantIndex(fetch, {
    url: config.QDRANT_URL,
    collection: config.QDRANT_COLLECTION,
    dimension: embedder.dimension,
    apiKey: config.QDRANT_API_KEY || undefined,
  });
  return { embedder, vectorIndex };
};

// `open` runs on the first search, not at import, so listing the agents needs no network. A failed
// open is not kept: the next search tries again.
export const createSearchKnowledgeBase = (
  open: () => Promise<KnowledgeBase>,
): SearchKnowledgeBase => {
  let opened: Promise<KnowledgeBase> | undefined;
  const knowledgeBase = () =>
    (opened ??= open().catch((err) => {
      opened = undefined;
      throw err;
    }));

  return async ({ query, source }) => {
    const { embedder, vectorIndex } = await knowledgeBase();
    const hits = await vectorIndex.search({
      vector: await embedder.embedQuery(query),
      k: HITS,
      ...(source && { filter: { source } }),
    });
    return {
      hits: hits.map(({ score, payload }) => ({
        score,
        source: String(payload.source),
        docId: String(payload.doc_id),
        sectionPath: String(payload.section_path),
        text: String(payload.text),
      })),
    };
  };
};
