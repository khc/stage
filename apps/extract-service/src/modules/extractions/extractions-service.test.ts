import { describe, expect, test } from "bun:test";

import type { Extraction, Xberg } from "../../platform/xberg-client";
import { createExtractionsService } from "./extractions-service";

const extraction: Extraction = { mimeType: "text/plain", content: "hi", pages: [] };
const file = new File(["hi"], "a.txt", { type: "text/plain" });

describe("extractions service", () => {
  test("returns what the parser produced", async () => {
    const xberg: Xberg = { extract: async () => extraction };
    expect(await createExtractionsService({ xberg }).extract(file)).toEqual({
      status: "extracted",
      extraction,
    });
  });

  test("a parser error is the status extraction_failed with its message", async () => {
    const xberg: Xberg = {
      extract: async () => {
        throw new Error("boom");
      },
    };
    expect(await createExtractionsService({ xberg }).extract(file)).toEqual({
      status: "extraction_failed",
      message: "boom",
    });
  });

  test("a thrown value that is not an Error gets a generic message", async () => {
    const xberg: Xberg = { extract: async () => Promise.reject("odd") };
    expect(await createExtractionsService({ xberg }).extract(file)).toEqual({
      status: "extraction_failed",
      message: "extraction failed",
    });
  });
});
