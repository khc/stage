export type ExtractedDocument = { content: string; mimeType: string };

// The file could not be turned into text (the extract service answered 422).
export class ExtractionError extends Error {}

export type ExtractClient = {
  extract: (file: File) => Promise<ExtractedDocument>;
};

export type ExtractClientOptions = {
  // The value of the Authorization header, for an authenticated extract service (see id-token.ts).
  authorization?: () => Promise<string>;
  // How long one extraction may take before it is abandoned; defaults to 60 seconds.
  timeoutMs?: number;
};

// Rejects when the signal aborts before the promise settles.
const withinSignal = <T>(promise: Promise<T>, signal: AbortSignal) =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    ),
  ]);

export const createExtractClient = (
  baseUrl: string,
  { authorization, timeoutMs = 60_000 }: ExtractClientOptions = {},
): ExtractClient => ({
  async extract(file) {
    const form = new FormData();
    form.set("file", file, file.name);
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      body: form,
      signal,
      ...(authorization && {
        headers: { authorization: await withinSignal(authorization(), signal) },
      }),
    });
    if (res.status === 422) throw new ExtractionError(await res.text());
    if (!res.ok) throw new Error(`extract service failed: HTTP ${res.status}`);
    return res.json() as Promise<ExtractedDocument>;
  },
});
