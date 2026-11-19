import type { CatalogSink, Chunk, Connector, DiscoveryBatch } from "./catalog";
import { pointId } from "./ids";
import type { Embedder } from "./platform/embeddings-client";
import type { VectorIndex } from "./platform/qdrant-client";

export type IngestionDeps = {
  catalogSink: CatalogSink;
  embedder: Embedder;
  vectorIndex: VectorIndex;
};

export type IngestSummary = {
  documents: number;
  // Sums over the batches, before the sink drops duplicates.
  nodes: number;
  edges: number;
  chunks: number;
  skipped: number;
};

export type Ingestion = {
  run: (connector: Connector) => Promise<IngestSummary>;
};

const EMPTY_HASHES: ReadonlyMap<string, string | null> = new Map();

const chunkHash = (text: string, fingerprint = "") =>
  new Bun.CryptoHasher("sha256").update(fingerprint).update("\0").update(text).digest("hex");

const toPayload = (source: string, chunk: Chunk, hash: string) => ({
  source,
  doc_id: chunk.docId,
  section_id: chunk.sectionId,
  section_path: chunk.sectionPath,
  chunk_index: chunk.index,
  chunk_id: chunk.id,
  chunk_hash: hash,
  text: chunk.text,
});

const count = (summary: IngestSummary, { nodes, edges, chunks }: DiscoveryBatch) => {
  summary.documents += nodes.filter((node) => node.kind === "document").length;
  summary.nodes += nodes.length;
  summary.edges += edges.length;
  summary.chunks += chunks?.length ?? 0;
};

export const createIngestion = ({
  catalogSink,
  embedder,
  vectorIndex,
}: IngestionDeps): Ingestion => {
  // Embeds changed/new chunks first, so a failed embedding deletes nothing; then upserts and prunes stale points.
  const index = async (
    source: string,
    chunks: Chunk[],
    existing: ReadonlyMap<string, string | null>,
  ) => {
    const items = chunks.map((chunk) => ({
      chunk,
      id: pointId(chunk.id),
      hash: chunkHash(chunk.text, embedder.fingerprint),
    }));
    const currentIds = new Set(items.map((item) => item.id));
    const toEmbed = items.filter((item) => existing.get(item.id) !== item.hash);
    const staleIds = [...existing.keys()].filter((id) => !currentIds.has(id));
    if (toEmbed.length > 0) {
      const vectors = await embedder.embed(toEmbed.map(({ chunk }) => chunk.text));
      await vectorIndex.upsert(
        toEmbed.map(({ chunk, id, hash }, i) => ({
          id,
          vector: vectors[i]!,
          payload: toPayload(source, chunk, hash),
        })),
      );
    }
    if (staleIds.length > 0) {
      await vectorIndex.deleteIds(staleIds);
    }
  };

  return {
    async run(connector) {
      const summary: IngestSummary = { documents: 0, nodes: 0, edges: 0, chunks: 0, skipped: 0 };
      try {
        const existingByDoc = await vectorIndex.listSourceHashes(connector.source);
        // One document at a time: the embedding server and Qdrant take the documents in order.
        // oxlint-disable eslint/no-await-in-loop
        for await (const batch of connector.discover()) {
          // The catalog entry follows the chunks, so it never lists chunks that were not stored.
          if (batch.chunks?.length) {
            await index(
              connector.source,
              batch.chunks,
              existingByDoc.get(batch.chunks[0]!.docId) ?? EMPTY_HASHES,
            );
          }
          await catalogSink.write(batch);
          count(summary, batch);
        }
        // oxlint-enable eslint/no-await-in-loop
      } catch (err) {
        await catalogSink.abort?.();
        throw err;
      }
      await catalogSink.close();
      summary.skipped = connector.skipped().length;
      return summary;
    },
  };
};
