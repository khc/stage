import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarProvider } from "@/components/ui/sidebar";

import { AppSidebar } from "./app-sidebar";

test("AppSidebar renders the Assistant link on top of the left side panel before Workspace", async () => {
  const rootRoute = createRootRoute({ component: () => null });
  const assistantRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/assistant",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([assistantRoute]),
    history: createMemoryHistory({ initialEntries: ["/assistant"] }),
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
  expect(html).toContain('href="/assistant"');
  expect(html).toContain('src="/stage.png"');
  expect(html).toMatch(/<a[^>]*href="\/"[^>]*>.*?<svg.*?Overview/);
  expect(html).toMatch(/<a[^>]*href="\/tasks"[^>]*>.*?<svg.*?Tasks/);
  expect(html).toMatch(/<a[^>]*href="\/jobs"[^>]*>.*?<svg.*?Jobs/);
  expect(html).toMatch(/<a[^>]*href="\/settings\/providers"[^>]*>.*?<svg.*?Providers/);
  expect(html).toMatch(/<a[^>]*href="\/docs"[^>]*>.*?<svg.*?API reference/);
  expect(html).toMatch(/data-active=""[^>]*href="\/assistant"|href="\/assistant"[^>]*data-active=""/);
});
