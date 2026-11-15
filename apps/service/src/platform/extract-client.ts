export type ExtractedDocument = { content: string; mimeType: string };

// The file could not be turned into text (the extract service answered 422).
export class ExtractionError extends Error {}

export type ExtractClient = {
  extract: (file: File) => Promise<ExtractedDocument>;
};

export type ExtractClientOptions = {
  // The value of the Authorization header, for an authenticated extract service (see id-token.ts).
  authorization?: () => Promise<string>;
};

export const createExtractClient = (
  baseUrl: string,
  { authorization }: ExtractClientOptions = {},
): ExtractClient => ({
  async extract(file) {
    const form = new FormData();
    form.set("file", file, file.name);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      body: form,
      ...(authorization && { headers: { authorization: await authorization() } }),
    });
    if (res.status === 422) throw new ExtractionError(await res.text());
    if (!res.ok) throw new Error(`extract service failed: HTTP ${res.status}`);
    return res.json() as Promise<ExtractedDocument>;
  },
});
