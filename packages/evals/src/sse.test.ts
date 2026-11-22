import { expect, test } from "bun:test";

import { parseSse } from "./sse";

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

const collect = async (body: ReadableStream<Uint8Array>) => {
  const items = [];
  for await (const item of parseSse(body)) items.push(item);
  return items;
};

test("parses an event with an id and data", async () => {
  expect(await collect(stream('id: e1\ndata: {"a":1}\n\n'))).toEqual([
    { id: "e1", data: '{"a":1}' },
  ]);
});

test("reassembles a line split across two chunks", async () => {
  expect(await collect(stream("id: e", "1\ndata: hel", "lo\n\n"))).toEqual([
    { id: "e1", data: "hello" },
  ]);
});

test("accepts CRLF line endings, also split between chunks", async () => {
  expect(await collect(stream("id: e1\r\ndata: x\r", "\n\r\n"))).toEqual([{ id: "e1", data: "x" }]);
});

test("joins data lines of one event with a newline", async () => {
  expect(await collect(stream("data: one\ndata: two\n\n"))).toEqual([{ data: "one\ntwo" }]);
});

test("yields the keepalive event with empty data", async () => {
  expect(await collect(stream("event: keepalive\ndata: \n\nid: e1\ndata: x\n\n"))).toEqual([
    { event: "keepalive", data: "" },
    { id: "e1", data: "x" },
  ]);
});

test("ignores comment lines and drops an unfinished event", async () => {
  expect(await collect(stream(": comment\ndata: a\n\ndata: unfinished"))).toEqual([{ data: "a" }]);
});
