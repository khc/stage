import dashboard from "./index.html";

const defaultServiceUrl = process.env.SERVICE_URL ?? "http://localhost:3000";

export const createWebFetch =
  (serviceUrl = defaultServiceUrl) =>
  (req: Request) => {
    const url = new URL(req.url);
    return fetch(new URL(url.pathname + url.search, serviceUrl), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
    });
  };

export default {
  port: Number(process.env.WEB_PORT ?? process.env.PORT ?? 3001),
  routes: { "/": dashboard, "/web": dashboard, "/web/": dashboard },
  development: process.env.NODE_ENV !== "production",
  fetch: createWebFetch(),
};
