import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { ExtractFile } from "./extract";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const createApp = (extractFile: ExtractFile) =>
  new Hono()
    .get("/health", (c) => c.json({ ok: true }))
    .post(
      "/extract",
      bodyLimit({
        maxSize: MAX_FILE_BYTES,
        onError: (c) => c.json({ error: "file too large" }, 413),
      }),
      async (c) => {
        const body = await c.req.parseBody().catch(() => null);
        const file = body?.file;
        if (!(file instanceof File)) {
          return c.json({ error: "multipart field 'file' is required" }, 400);
        }
        try {
          return c.json(await extractFile(file));
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : "extraction failed" }, 422);
        }
      },
    );
