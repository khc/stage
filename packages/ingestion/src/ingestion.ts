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

const toPayload = (source: string, chunk: Chunk) => ({
  source,
  doc_id: chunk.docId,
  section_id: chunk.sectionId,
  section_path: chunk.sectionPath,
  chunk_index: chunk.index,
  chunk_id: chunk.id,
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
  // Embeds first, so a failed embedding deletes nothing; then replaces the document's points.
  const index = async (source: string, chunks: Chunk[]) => {
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.text));
    await vectorIndex.deleteWhere({ source, doc_id: chunks[0]!.docId });
    await vectorIndex.upsert(
      chunks.map((chunk, i) => ({
        id: pointId(chunk.id),
        vector: vectors[i]!,
        payload: toPayload(source, chunk),
      })),
    );
  };

  return {
    async run(connector) {
      const summary: IngestSummary = { documents: 0, nodes: 0, edges: 0, chunks: 0, skipped: 0 };
      try {
        // One document at a time: the embedding server and Qdrant take the documents in order.
        // oxlint-disable eslint/no-await-in-loop
        for await (const batch of connector.discover()) {
          // The catalog entry follows the chunks, so it never lists chunks that were not stored.
          if (batch.chunks?.length) await index(connector.source, batch.chunks);
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
