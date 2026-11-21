import { expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AssistantComposer } from "./assistant-composer";
import type { AssistantTargetOption, ChatTurn } from "./assistant-model";
import { AssistantThread } from "./assistant-thread";

test("AssistantThread welcome state highlights the orchestrator default and starter prompts", () => {
  const html = renderToStaticMarkup(
    <AssistantThread
      turns={[]}
      target={{ jobName: "orchestrator", agentName: "orchestrator" }}
      onStarterSelect={() => {}}
    />,
  );

  expect(html).toContain("How can I help today?");
  expect(html).toContain('src="/stage.png"');
  expect(html).toContain("orchestrator (orchestrator)");
  expect(html).toContain("Summarize what agents and tools are available");
});

test("AssistantThread renders user and Markdown assistant turns without raw technical dumps", () => {
  const turns: ChatTurn[] = [
    { id: "u1", kind: "user", text: "What did we find?" },
    {
      id: "a1",
      kind: "assistant",
      author: "orchestrator",
      thoughts: ["Reviewing extracted documents."],
      tools: [
        {
          id: "t1",
          name: "search_docs",
          args: { q: "summary" },
          response: { ok: true },
          pending: false,
        },
      ],
      textSegments: ["Here is the **key result**:\n\n- Item A"],
    },
  ];

  const html = renderToStaticMarkup(
    <AssistantThread turns={turns} onStarterSelect={() => {}} />,
  );

  expect(html).toContain("What did we find?");
  expect(html).toContain("<strong>key result</strong>");
  expect(html).toContain("<li>Item A</li>");
  expect(html).toContain("Thought");
  expect(html).toContain("Called search_docs");
  expect(html).not.toContain("Raw event");
  expect(html).not.toContain("Session state");
});

test("AssistantComposer renders target selector, attachment button, and disables send without text", () => {
  const options: AssistantTargetOption[] = [
    {
      id: '["orchestrator","orchestrator"]',
      jobName: "orchestrator",
      agentName: "orchestrator",
      label: "orchestrator · orchestrator",
      isOrchestrator: true,
    },
  ];

  const emptyHtml = renderToStaticMarkup(
    <AssistantComposer
      value="   "
      onChange={() => {}}
      onSubmit={() => {}}
      target={{ jobName: "orchestrator", agentName: "orchestrator" }}
      targetOptions={options}
      stagedFiles={[new File(["hi"], "notes.txt")]}
      onTargetChange={() => {}}
      onAttachFiles={() => {}}
    />,
  );

  expect(emptyHtml).toContain("notes.txt");
  expect(emptyHtml).toContain("orchestrator · orchestrator");
  expect(emptyHtml).toContain('aria-label="Attach file"');
  expect(emptyHtml).toContain('aria-label="Send message"');
  expect(emptyHtml).toMatch(/disabled=""[^>]*aria-label="Send message"|aria-label="Send message"[^>]*disabled=""/);
});
