import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Renders a component that reads the router and query cache, with the cache pre-filled.
export async function renderWithApp(
  node: ReactNode,
  cache: [queryKey: string[], data: unknown][] = [],
) {
  const rootRoute = createRootRoute({ component: () => null });
  const routes = ["/", "/tasks", "/jobs"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const client = new QueryClient();
  for (const [key, data] of cache) client.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={router}>{node}</RouterContextProvider>
    </QueryClientProvider>,
  );
}

// Server rendering has no localStorage; the theme provider reads its saved choices from it.
// Call restoreLocalStorage() in afterEach.
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

export function stubLocalStorage(saved: Record<string, string> = {}) {
  const store = new Map(Object.entries(saved));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: () => {} },
  });
}

export function restoreLocalStorage() {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}
