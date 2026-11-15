import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";

import { openApiDocument } from "../openapi";

export const metaRoute = () =>
  new Hono()
    .get("/openapi.json", (c) => c.json(openApiDocument))
    .get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Agent Jobs API" }))
    .get("/health", (c) => c.json({ status: "ok" }));
