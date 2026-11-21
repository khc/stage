import { expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { SubagentTrace, ToolTrace } from "./agent-trace";

test("a finished delegation reads Delegated to <agent> with its job", () => {
  const html = renderToStaticMarkup(
    <SubagentTrace
      job="poet-agents"
      agent="haiku-poet"
      args={{ topic: "autumn" }}
      response={{ result: "Leaves fall" }}
    />,
  );
  expect(html).toContain("Delegated to haiku-poet");
  expect(html).toContain("poet-agents");
});

test("a running delegation reads Delegating to <agent>", () => {
  const html = renderToStaticMarkup(<SubagentTrace job="poet-agents" agent="haiku-poet" pending />);
  expect(html).toContain("Delegating to haiku-poet");
  expect(html).toContain('data-status="running"');
});

test("a tool call reads Called <name> once it has a result", () => {
  const html = renderToStaticMarkup(
    <ToolTrace name="search_docs" args={{ q: "x" }} response={{ ok: true }} />,
  );
  expect(html).toContain("Called search_docs");
});
