import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { createExtractClient, ExtractionError } from "./extract-client";

let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => spy?.mockRestore());

const respond = (response: Response) => {
  const fetch = mock(async (_url: string, _init?: RequestInit) => response);
  spy = spyOn(globalThis, "fetch").mockImplementation(fetch as unknown as typeof globalThis.fetch);
  return fetch;
};
const file = new File(["hi"], "a.txt", { type: "text/plain" });

test("posts the file to /extract and returns the text, with no credentials by default", async () => {
  const fetch = respond(Response.json({ content: "hi", mimeType: "text/plain" }));
  expect(await createExtractClient("http://extract:8080/").extract(file)).toEqual({
    content: "hi",
    mimeType: "text/plain",
  });
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://extract:8080/extract");
  expect(init.method).toBe("POST");
  expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  expect(init.headers).toBeUndefined();
});

test("sends the Authorization header when the extract service is authenticated", async () => {
  const fetch = respond(Response.json({ content: "x", mimeType: "text/plain" }));
  const authorization = mock(async () => "Bearer id-token");
  await createExtractClient("https://extract.run.app", { authorization }).extract(file);
  expect((fetch.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({
    authorization: "Bearer id-token",
  });
  expect(authorization).toHaveBeenCalledTimes(1);
});

test("a failure to get the ID token fails the call before anything is sent", async () => {
  const fetch = respond(Response.json({}));
  const authorization = async () => {
    throw new Error("no credentials");
  };
  await expect(createExtractClient("https://e", { authorization }).extract(file)).rejects.toThrow(
    "no credentials",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("a 422 is an ExtractionError and any other failure is a plain error", async () => {
  respond(new Response("bad file", { status: 422 }));
  await expect(createExtractClient("http://e").extract(file)).rejects.toBeInstanceOf(
    ExtractionError,
  );
  respond(new Response("down", { status: 503 }));
  await expect(createExtractClient("http://e").extract(file)).rejects.toThrow("HTTP 503");
});

test("abandons an extraction that does not answer within the timeout", async () => {
  spy = spyOn(globalThis, "fetch").mockImplementation(
    ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof globalThis.fetch,
  );
  await expect(
    createExtractClient("http://extract:8080", { timeoutMs: 20 }).extract(file),
  ).rejects.toThrow();
});

test("abandons an ID token that is not ready within the timeout", async () => {
  const fetch = respond(Response.json({}));
  const authorization = () => new Promise<string>(() => {});
  await expect(
    createExtractClient("https://extract.run.app", { authorization, timeoutMs: 20 }).extract(file),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
