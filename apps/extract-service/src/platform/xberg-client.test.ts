import { expect, test } from "bun:test";

import type { ExtractedDocument } from "@xberg-io/xberg";

import { toExtraction } from "./xberg-client";

test("maps a parsed document to text, pages and regions", () => {
  const doc = {
    mimeType: "application/pdf",
    content: "hello",
    pages: [
      {
        pageNumber: 1,
        content: "hello",
        layoutRegions: [
          { className: "title", confidence: 0.9, boundingBox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
        ],
      },
    ],
  } as unknown as ExtractedDocument;
  expect(toExtraction(doc)).toEqual({
    mimeType: "application/pdf",
    content: "hello",
    pages: [
      {
        page: 1,
        content: "hello",
        regions: [{ type: "title", confidence: 0.9, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }],
      },
    ],
  });
});

test("fills what the parser leaves out with empty values", () => {
  const doc = {
    pages: [{ pageNumber: 2, content: "x", layoutRegions: [{}] }],
  } as unknown as ExtractedDocument;
  expect(toExtraction(doc)).toEqual({
    mimeType: "",
    content: "",
    pages: [
      {
        page: 2,
        content: "x",
        regions: [{ type: "unknown", confidence: 0, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } }],
      },
    ],
  });
  expect(toExtraction({} as ExtractedDocument)).toEqual({ mimeType: "", content: "", pages: [] });
});
