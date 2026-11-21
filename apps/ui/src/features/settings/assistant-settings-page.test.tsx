import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantSettingsPage } from "./assistant-settings-page";

test("AssistantSettingsPage offers a default agent and a default execution mode", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["jobs"], { jobs: [{ name: "projects/p/locations/l/jobs/worker" }] });
  client.setQueryData(["agents", "worker"], { agents: [{ name: "haiku-poet" }] });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AssistantSettingsPage />
    </QueryClientProvider>,
  );
  expect(html).toContain("Default agent");
  expect(html).toContain("Default execution mode");
  expect(html).toContain("Automatic (orchestrator)");
  expect(html).toContain("Job");
  expect(html).toContain("Default model");
  expect(html).toContain(">Save</button>");
  expect(html).toContain("Saved in this browser.");
});
