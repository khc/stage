// What a connector discovers: catalog nodes and edges for the graph, and the chunks to embed.
// Ids are deterministic and source-scoped (see ids.ts).

export type CatalogNode = {
  id: string;
  // The structured kinds are reserved for connectors that are not built yet.
  kind: "source" | "document" | "section" | "table" | "column" | "endpoint" | "schema" | "field";
  source: string;
  name: string;
  props?: Record<string, string | number | boolean | string[]>;
};

export type CatalogEdge = {
  from: string;
  to: string;
  type: "CONTAINS" | "REFERENCES" | "LINKS_TO";
};

export type Chunk = {
  id: string;
  docId: string;
  sectionId: string;
  sectionPath: string;
  index: number;
  text: string;
};

export type DiscoveryBatch = {
  nodes: CatalogNode[];
  edges: CatalogEdge[];
  chunks?: Chunk[];
};

export type SkippedFile = { path: string; reason: string };

export type Connector = {
  source: string;
  discover: () => AsyncIterable<DiscoveryBatch>;
  // Files the connector could not parse, valid once `discover` has finished.
  skipped: () => SkippedFile[];
};

// Where catalog nodes and edges go; sinks ignore `chunks`. `close` commits what was written, and is
// called only when a run completed; after a failed run `abort` is called instead, so a sink can
// leave what it held before untouched.
export type CatalogSink = {
  write: (batch: DiscoveryBatch) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};
