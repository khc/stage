import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarProvider } from "@/components/ui/sidebar";
import { router as appRouter } from "@/router";

import { AppSidebar } from "./app-sidebar";

test("AppSidebar renders the Assistant link on top of the left side panel before Workspace", async () => {
  const router = createRouter({
    routeTree: appRouter.routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();

  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={router}>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </RouterContextProvider>
    </QueryClientProvider>,
  );

  const assistantIdx = html.indexOf("Assistant");
  const workspaceIdx = html.indexOf("Workspace");
  const overviewIdx = html.indexOf("Overview");
  const settingsIdx = html.indexOf("Settings");
  const referenceIdx = html.indexOf("Reference");
  expect(assistantIdx).toBeGreaterThan(-1);
  expect(workspaceIdx).toBeGreaterThan(assistantIdx);
  expect(overviewIdx).toBeGreaterThan(workspaceIdx);
  expect(settingsIdx).toBeGreaterThan(workspaceIdx);
  expect(referenceIdx).toBeGreaterThan(settingsIdx);
  const assistantLink = html.match(/<a[^>]*>(?:(?!<\/a>).)*>Assistant<\/span><\/a>/)?.[0];
  expect(assistantLink).toContain('href="/"');
  expect(assistantLink).toContain('data-active=""');
  expect(html).toContain('src="/stage.svg"');
  const homeLink = html.match(
    /<a(?=[^>]*aria-label="Stage home")(?=[^>]*href="\/")[^>]*>(.*?)<\/a>/,
  );
  expect(homeLink?.[1]).toMatch(/^<span class="[^"]*\bfont-display\b[^"]*">Stage<\/span>$/);
  const overviewLink = html.match(/<a[^>]*>(?:(?!<\/a>).)*>Overview<\/span><\/a>/)?.[0];
  expect(overviewLink).toContain('href="/overview"');
  expect(overviewLink).not.toContain('data-active=""');
  expect(html).toMatch(/<a[^>]*href="\/tasks"[^>]*>.*?<svg.*?Tasks/);
  expect(html).toMatch(/<a[^>]*href="\/jobs"[^>]*>.*?<svg.*?Jobs/);
  expect(html).toMatch(/<a[^>]*href="\/settings\/providers"[^>]*>.*?<svg.*?Providers/);
  expect(html).toMatch(/<a[^>]*href="\/docs"[^>]*>.*?<svg.*?API reference/);
});
