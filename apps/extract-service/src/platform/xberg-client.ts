import { ExtractInputKind, extract, type ExtractedDocument } from "@xberg-io/xberg";

export type Region = {
  type: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

export type Extraction = {
  mimeType: string;
  content: string;
  pages: { page: number; content: string; regions: Region[] }[];
};

// The xberg document parser (a native module): turns a file into text, pages and layout regions.
export type Xberg = {
  // Throws when xberg cannot parse the file.
  extract: (file: File) => Promise<Extraction>;
};

const config = {
  pages: { extractPages: true },
  layout: {},
};

export const toExtraction = (doc: ExtractedDocument): Extraction => ({
  mimeType: doc.mimeType ?? "",
  content: doc.content ?? "",
  pages: (doc.pages ?? []).map((p) => ({
    page: p.pageNumber,
    content: p.content,
    regions: (p.layoutRegions ?? []).map((r) => ({
      type: r.className ?? "unknown",
      confidence: r.confidence ?? 0,
      bbox: {
        x0: r.boundingBox?.x0 ?? 0,
        y0: r.boundingBox?.y0 ?? 0,
        x1: r.boundingBox?.x1 ?? 0,
        y1: r.boundingBox?.y1 ?? 0,
      },
    })),
  })),
});

export const createXberg = (): Xberg => ({
  async extract(file) {
    const result = await extract(
      {
        kind: ExtractInputKind.Bytes,
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        mimeType: file.type || undefined,
      },
      config,
    );
    const error = result.errors?.[0];
    const doc = result.results?.[0];
    if (!doc) throw new Error(error?.message ?? "extraction failed");
    return toExtraction(doc);
  },
});
