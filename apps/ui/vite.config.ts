import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// SPA routes that share a path with an API route: browser navigations get the app.
const isSpaRoute = (path: string) => /^\/(tasks|jobs)(\/[^/]+)?$/.test(path);

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, "../.."), "");
  const target = env.SERVICE_URL ?? "http://localhost:3000";
  const proxy = {
    target,
    bypass: (req: { url?: string; headers: { accept?: string } }) =>
      isSpaRoute(req.url?.split("?")[0] ?? "") && req.headers.accept?.includes("text/html")
        ? "/index.html"
        : undefined,
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
    server: {
      proxy: Object.fromEntries(
        ["/tasks", "/jobs", "/providers", "/health", "/events", "/docs", "/openapi.json"].map(
          (path) => [path, proxy],
        ),
      ),
    },
  };
});
