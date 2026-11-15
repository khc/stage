import { t } from "elysia";

// A larger upload is refused with 413 before it is read.
export const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;

export const ExtractionsModel = {
  // Response shape, used only to document the API.
  extraction: t.Object({
    mimeType: t.String(),
    content: t.String(),
    pages: t.Array(
      t.Object({
        page: t.Number(),
        content: t.String(),
        regions: t.Array(
          t.Object({
            type: t.String(),
            confidence: t.Number(),
            bbox: t.Object({ x0: t.Number(), y0: t.Number(), x1: t.Number(), y1: t.Number() }),
          }),
        ),
      }),
    ),
  }),
} as const;

export type ExtractionsModel = {
  [K in keyof typeof ExtractionsModel]: (typeof ExtractionsModel)[K]["static"];
};
