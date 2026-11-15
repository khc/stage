import type { Extraction, Xberg } from "../../platform/xberg-client";

export type ExtractionsServiceDeps = { xberg: Xberg };

export type ExtractResult =
  | { status: "extracted"; extraction: Extraction }
  | { status: "extraction_failed"; message: string };

// Every expected outcome is a status: a file the parser cannot read is one, whatever the reason.
export type ExtractionsService = {
  extract: (file: File) => Promise<ExtractResult>;
};

export const createExtractionsService = ({
  xberg,
}: ExtractionsServiceDeps): ExtractionsService => ({
  async extract(file) {
    try {
      return { status: "extracted", extraction: await xberg.extract(file) };
    } catch (err) {
      return {
        status: "extraction_failed",
        message: err instanceof Error ? err.message : "extraction failed",
      };
    }
  },
});
