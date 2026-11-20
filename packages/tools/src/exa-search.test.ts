import { expect, test } from "bun:test";

import type { Context } from "@google/adk";

import { createExaSearchTool } from "./exa-search";

// The injected query reader ignores context here. The discovery runner tests supply real context.
const toolContext = {} as Context;

test("requests Exa highlights with only the query from the caller", async () => {
  let request: Request | undefined;
  const search = createExaSearchTool({
    getApiKey: () => "test-key",
    getQuery: () => "  Bun test documentation  ",
    fetchSearch: async (url, init) => {
      request = new Request(url, init);
      return Response.json({
        results: [
          {
            url: "https://bun.com/docs/test",
            title: "Bun test runner",
            highlights: ["Run tests with bun test."],
          },
        ],
      });
    },
  });

  expect(await search.runAsync({ args: { query: "model-supplied text" }, toolContext })).toEqual({
    results: [
      {
        url: "https://bun.com/docs/test",
        title: "Bun test runner",
        highlights: ["Run tests with bun test."],
      },
    ],
  });
  expect(request?.url).toBe("https://api.exa.ai/search");
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("x-api-key")).toBe("test-key");
  expect(request?.headers.get("content-type")).toBe("application/json");
  expect(await request?.json()).toEqual({
    query: "Bun test documentation",
    type: "auto",
    numResults: 5,
    contents: { highlights: true },
  });
});

test("passes the model-supplied query to the query resolver", async () => {
  let body: { query?: string } | undefined;
  const search = createExaSearchTool({
    getApiKey: () => "test-key",
    getQuery: (_context, modelQuery) => modelQuery,
    fetchSearch: async (url, init) => {
      body = await new Request(url, init).json();
      return Response.json({ results: [] });
    },
  });

  await search.runAsync({ args: { query: "  Bun docs  " }, toolContext });

  expect(body?.query).toBe("Bun docs");
});

test("bounds and normalizes results while skipping invalid URLs", async () => {
  const url = "https://example.com/docs";
  const search = createExaSearchTool({
    getApiKey: () => "test-key",
    getQuery: () => "documentation",
    fetchSearch: async () =>
      Response.json({
        results: [
          { url: "file:///tmp/private" },
          { url: "https://" },
          { url, title: null, highlights: ["a".repeat(501), "second", "third"] },
          ...Array.from({ length: 5 }, (_, index) => ({ url: `${url}/${index}` })),
        ],
      }),
  });

  expect(await search.runAsync({ args: {}, toolContext })).toEqual({
    results: [
      { title: url, url, highlights: ["a".repeat(500), "second"] },
      { title: `${url}/0`, url: `${url}/0`, highlights: [] },
      { title: `${url}/1`, url: `${url}/1`, highlights: [] },
      { title: `${url}/2`, url: `${url}/2`, highlights: [] },
      { title: `${url}/3`, url: `${url}/3`, highlights: [] },
    ],
  });
});

test.each([undefined, "   ", "a".repeat(501)])(
  "does not search without a valid caller query %#",
  async (query) => {
    const search = createExaSearchTool({
      getApiKey: () => "test-key",
      getQuery: () => query,
      fetchSearch: async () => expect.unreachable("Exa must not be contacted"),
    });

    expect(await search.runAsync({ args: { query: "model fallback" }, toolContext })).toEqual({
      error: "web_search_query_required",
    });
  },
);

test.each([undefined, "  "])("does not search with a missing or blank key %#", async (key) => {
  const search = createExaSearchTool({
    getApiKey: () => key,
    getQuery: () => "documentation",
    fetchSearch: async () => expect.unreachable("Exa must not be contacted"),
  });

  expect(await search.runAsync({ args: {}, toolContext })).toEqual({
    error: "web_search_not_configured",
  });
});

test("returns an empty result set when Exa finds nothing", async () => {
  const search = createExaSearchTool({
    getApiKey: () => "test-key",
    getQuery: () => "documentation",
    fetchSearch: async () => Response.json({ results: [] }),
  });

  expect(await search.runAsync({ args: {}, toolContext })).toEqual({ results: [] });
});

test.each([
  ["non-success status", () => new Response("provider details", { status: 429 })],
  ["invalid JSON", () => new Response("not JSON")],
  ["malformed payload", () => Response.json({ results: false })],
])("returns a safe error for %s", async (_case, response) => {
  const search = createExaSearchTool({
    getApiKey: () => "test-key",
    getQuery: () => "documentation",
    fetchSearch: async () => response(),
  });

  expect(await search.runAsync({ args: {}, toolContext })).toEqual({
    error: "web_search_unavailable",
  });
});

test.each([new TypeError("network failure"), new DOMException("timed out", "TimeoutError")])(
  "returns a safe error for an interrupted request %#",
  async (error) => {
    const search = createExaSearchTool({
      getApiKey: () => "test-key",
      getQuery: () => "documentation",
      fetchSearch: async () => {
        throw error;
      },
    });

    expect(await search.runAsync({ args: {}, toolContext })).toEqual({
      error: "web_search_unavailable",
    });
  },
);
