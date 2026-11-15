import { Elysia } from "elysia";

import { MAX_EXTRACT_BYTES } from "./extractions-model";
import type { ExtractionsService } from "./extractions-service";

// POST /extract: the multipart field `file` in, its text, pages and layout regions out.
export const extractionsController = (extractionsService: ExtractionsService) =>
  new Elysia().post(
    "/extract",
    async ({ body, status }) => {
      const file = (body as { file?: unknown } | undefined)?.file;
      if (!(file instanceof File)) {
        return status(400, { error: "multipart field 'file' is required" });
      }
      const result = await extractionsService.extract(file);
      if (result.status === "extraction_failed") return status(422, { error: result.message });
      return result.extraction;
    },
    {
      beforeHandle: ({ request, status }) => {
        if (Number(request.headers.get("content-length")) > MAX_EXTRACT_BYTES)
          return status(413, { error: "file too large" });
      },
    },
  );
