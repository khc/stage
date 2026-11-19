import { expect, test } from "bun:test";

import { chunkId, nodeId, pointId, sourceId } from "./ids";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("source, node and chunk ids are deterministic and source-scoped", () => {
  expect(sourceId("bun")).toBe("bun");
  expect(nodeId("bun", "runtime/http/server.mdx")).toBe("bun:runtime/http/server.mdx");
  expect(nodeId("bun", "runtime/http/server.mdx")).toBe(nodeId("bun", "runtime/http/server.mdx"));
  expect(chunkId("bun:runtime/http/server.mdx#basic-setup", 2)).toBe(
    "bun:runtime/http/server.mdx#basic-setup:2",
  );
});

test("a source id cannot collide with a node id", () => {
  expect(sourceId("bun")).not.toContain(":");
  expect(nodeId("bun", "x")).toContain(":");
});

test("pointId is a stable version 5 uuid that differs per chunk id", () => {
  const a = pointId("bun:a.mdx#intro:0");
  expect(a).toMatch(uuid);
  expect(pointId("bun:a.mdx#intro:0")).toBe(a);
  expect(pointId("bun:a.mdx#intro:1")).not.toBe(a);
  expect(pointId("duckdb:a.md#intro:0")).not.toBe(a);
});
