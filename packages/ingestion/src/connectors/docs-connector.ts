import { join } from "node:path";

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import type {
  CatalogEdge,
  CatalogNode,
  Chunk,
  Connector,
  DiscoveryBatch,
  SkippedFile,
} from "../catalog";
import type { Corpus } from "../corpora";
import { chunkId, nodeId, sourceId } from "../ids";
import { docFormats, type DocFormat, type ParsedDoc } from "./doc-formats";

export type DocsConnectorOptions = {
  corpus: Corpus;
  // The clone of the corpus repo; the files are read from `<dir>/<corpus.path>`.
  dir: string;
  // The commit the clone is at, recorded on the source node.
  revision?: string;
  // Ingest only the first N documents in path order.
  limit?: number;
  // Characters per chunk (the section path prefix not counted), and the overlap between the
  // pieces of a block that is larger than that.
  chunkSize?: number;
  chunkOverlap?: number;
};

type Doc = { path: string; parsed: ParsedDoc };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

const listFiles = async (root: string, corpus: Corpus) => {
  const excluded = corpus.exclude.map((pattern) => new Bun.Glob(pattern));
  const paths: string[] = [];
  for await (const path of new Bun.Glob(corpus.include).scan({ cwd: root, onlyFiles: true })) {
    if (excluded.some((glob) => glob.match(path))) continue;
    if (
      corpus.maxFileBytes !== undefined &&
      Bun.file(join(root, path)).size > corpus.maxFileBytes
    ) {
      continue;
    }
    paths.push(path);
  }
  return paths.toSorted(byCodeUnit);
};

// Packs a section's blocks whole into chunks of at most `chunkSize` characters. A block larger than
// that goes through the markdown splitter on its own.
const packBlocks = async (
  blocks: string[],
  splitter: RecursiveCharacterTextSplitter,
  chunkSize: number,
) => {
  const splits = await Promise.all(
    blocks.map(async (block) =>
      block.length > chunkSize
        ? (await splitter.splitText(block)).filter((piece) => piece.trim())
        : undefined,
    ),
  );
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const [i, block] of blocks.entries()) {
    const split = splits[i];
    if (split) {
      flush();
      chunks.push(...split);
      continue;
    }
    const joined = current ? `${current}\n\n${block}` : block;
    if (joined.length <= chunkSize) {
      current = joined;
    } else {
      flush();
      current = block;
    }
  }
  flush();
  return chunks;
};

// The first of the document paths a link target can mean: the path itself, with an extension, or a
// folder index.
const resolveLink = (target: string, known: ReadonlySet<string>, format: DocFormat) =>
  [
    target,
    ...format.extensions.map((ext) => `${target}${ext}`),
    ...format.extensions.map((ext) => `${target}/index${ext}`),
  ].find((path) => known.has(path));

export const createDocsConnector = ({
  corpus,
  dir,
  revision,
  limit,
  chunkSize = 1000,
  chunkOverlap = 100,
}: DocsConnectorOptions): Connector => {
  const { source } = corpus;
  const format = docFormats[corpus.format];
  const root = join(dir, corpus.path);
  const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
    chunkSize,
    chunkOverlap,
  });
  let skipped: SkippedFile[] = [];

  const sourceNode = (): CatalogNode => ({
    id: sourceId(source),
    kind: "source",
    source,
    name: source,
    props: { repo: corpus.repo, path: corpus.path, ...(revision && { revision }) },
  });

  // One batch per document: its nodes, its edges and its chunks.
  const toBatch = async (doc: Doc, known: ReadonlySet<string>): Promise<DiscoveryBatch> => {
    const docId = nodeId(source, doc.path);
    const { title, description } = doc.parsed;
    const nodes: CatalogNode[] = [
      {
        id: docId,
        kind: "document",
        source,
        name: title,
        props: { title, ...(description && { description }), path: doc.path },
      },
    ];
    const edges: CatalogEdge[] = [{ from: sourceId(source), to: docId, type: "CONTAINS" }];
    const chunks: Chunk[] = [];
    const used = new Set<string>();
    // The id of the latest section at each depth of the path, to find a section's parent.
    const parents: string[] = [docId];

    const packed = await Promise.all(
      doc.parsed.sections.map((section) => packBlocks(section.blocks, splitter, chunkSize)),
    );
    for (const [i, section] of doc.parsed.sections.entries()) {
      const base = `${docId}#${section.path.length === 1 ? "_root" : section.path.slice(1).map(slug).join("/")}`;
      let sectionId = base;
      for (let n = 2; used.has(sectionId); n++) sectionId = `${base}-${n}`;
      used.add(sectionId);

      const sectionPath = section.path.join(" > ");
      const texts = packed[i] ?? [];
      const sectionChunks = texts.map((text, index): Chunk => ({
        id: chunkId(sectionId, index),
        docId,
        sectionId,
        sectionPath,
        index,
        text: `${sectionPath}\n\n${text}`,
      }));
      chunks.push(...sectionChunks);
      nodes.push({
        id: sectionId,
        kind: "section",
        source,
        name: section.path.at(-1) ?? title,
        props: {
          path: sectionPath,
          depth: section.depth,
          chunkIds: sectionChunks.map((c) => c.id),
        },
      });
      edges.push({
        from: parents[section.path.length - 1] ?? docId,
        to: sectionId,
        type: "CONTAINS",
      });
      parents.length = section.path.length;
      parents.push(sectionId);
    }

    const linked = new Set<string>();
    for (const link of doc.parsed.links) {
      const target = resolveLink(link, known, format);
      if (target && target !== doc.path) linked.add(target);
    }
    for (const target of linked) {
      edges.push({ from: docId, to: nodeId(source, target), type: "LINKS_TO" });
    }
    return { nodes, edges, chunks };
  };

  return {
    source,
    skipped: () => [...skipped],
    async *discover() {
      skipped = [];
      const paths = (await listFiles(root, corpus)).slice(0, limit);
      const files = await Promise.all(
        paths.map(async (path) => ({ path, text: await Bun.file(join(root, path)).text() })),
      );
      const docs: Doc[] = [];
      for (const { path, text } of files) {
        try {
          docs.push({ path, parsed: format.parse(text, path) });
        } catch (err) {
          skipped.push({ path, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      // Links resolve against the documents that parsed, so no edge points at a missing node.
      const known = new Set(docs.map((doc) => doc.path));
      const batches = await Promise.all(docs.map((doc) => toBatch(doc, known)));
      if (batches.length === 0) batches.push({ nodes: [], edges: [] });
      batches[0]!.nodes.unshift(sourceNode());
      yield* batches;
    },
  };
};
