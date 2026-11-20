import { FunctionTool, type Context } from "@google/adk";
import { z } from "zod";

const resultLimit = 5;
const querySchema = z.string().trim().min(1).max(500);
const responseSchema = z.object({ results: z.array(z.unknown()) });
const resultSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
});

export type ExaSearchToolDeps = {
  getApiKey: () => string | undefined;
  getQuery: (context: Context | undefined) => string | undefined;
  fetchSearch?: (url: string, init: RequestInit) => Promise<Response>;
};

export const createExaSearchTool = ({
  getApiKey,
  getQuery,
  fetchSearch = fetch,
}: ExaSearchToolDeps) =>
  new FunctionTool({
    name: "search_web",
    description: "Searches the public web using the caller's query and returns URLs and excerpts.",
    execute: async (_args, context) => {
      const query = querySchema.safeParse(getQuery(context));
      if (!query.success) return { error: "web_search_query_required" };

      const apiKey = getApiKey()?.trim();
      if (!apiKey) return { error: "web_search_not_configured" };

      try {
        const response = await fetchSearch("https://api.exa.ai/search", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({
            query: query.data,
            type: "auto",
            numResults: resultLimit,
            contents: { highlights: true },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return { error: "web_search_unavailable" };

        const payload = responseSchema.safeParse(await response.json());
        if (!payload.success) return { error: "web_search_unavailable" };

        const results = [];
        for (const entry of payload.data.results) {
          const result = resultSchema.safeParse(entry);
          if (!result.success) continue;
          const { title, url, highlights } = result.data;
          results.push({
            title: title?.trim() || url,
            url,
            highlights: highlights?.slice(0, 2).map((text) => text.slice(0, 500)) ?? [],
          });
          if (results.length === resultLimit) break;
        }
        return { results };
      } catch {
        return { error: "web_search_unavailable" };
      }
    },
  });
