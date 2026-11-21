import { expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AssistantComposer } from "./assistant-composer";
import type { AssistantTargetOption, ChatTurn } from "./assistant-model";
import { AssistantThread } from "./assistant-thread";

test("AssistantThread welcome state shows the animated Stage logo above the helper text", () => {
  const html = renderToStaticMarkup(
    <AssistantThread
      turns={[]}
      target={{ jobName: "orchestrator", agentName: "orchestrator" }}
      onStarterSelect={() => {}}
    />,
  );

  expect(html).not.toContain("How can I help today?");
  expect(html).toMatch(
    /<svg[^>]*class="stage-lava\b[^>]*>.*?<\/svg>.*?data-slot="empty-description"[^>]*>Start a conversation/,
  );
  expect(html).toContain('image.svg#wordmark"');
  expect(html).toContain('image.svg#tagline"');
  expect(html).toContain('image.svg#left-ribbons"');
  expect(html).toContain('image.svg#right-ribbons"');
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

  const html = renderToStaticMarkup(<AssistantThread turns={turns} onStarterSelect={() => {}} />);

  expect(html).toContain("What did we find?");
  expect(html).toContain("<strong>key result</strong>");
  expect(html).toContain("<li>Item A</li>");
  expect(html).toContain("Thought");
  expect(html).toContain("Called search_docs");
  expect(html).not.toContain("Raw event");
  expect(html).not.toContain("Session state");
  expect(html).not.toContain('class="stage-lava ');
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
      modelOptions={[]}
      onModelChange={() => {}}
      onAttachFiles={() => {}}
    />,
  );

  expect(emptyHtml).toContain("notes.txt");
  expect(emptyHtml).toContain("orchestrator · orchestrator");
  expect(emptyHtml).toContain('aria-label="Attach file"');
  expect(emptyHtml).toContain('aria-label="Send message"');
  expect(emptyHtml).toMatch(
    /disabled=""[^>]*aria-label="Send message"|aria-label="Send message"[^>]*disabled=""/,
  );
});

test("AssistantComposer shows the model picker with the chosen model, and hides it without models", () => {
  const base = {
    value: "hi",
    onChange: () => {},
    onSubmit: () => {},
    target: { jobName: "orchestrator" },
    targetOptions: [],
    onTargetChange: () => {},
    onAttachFiles: () => {},
  };
  const modelOptions = [
    { ref: { providerId: "p", model: "flash" }, label: "Express · flash" },
    { ref: { providerId: "p", model: "pro" }, label: "Express · pro" },
  ];
  const withModels = renderToStaticMarkup(
    <AssistantComposer
      {...base}
      modelOptions={modelOptions}
      model={modelOptions[1]!.ref}
      onModelChange={() => {}}
    />,
  );
  expect(withModels).toContain('aria-label="Model"');
  expect(withModels).toContain("Express · pro");

  const without = renderToStaticMarkup(
    <AssistantComposer {...base} modelOptions={[]} onModelChange={() => {}} />,
  );
  expect(without).not.toContain('aria-label="Model"');
});

test("AssistantComposer shows the agent and model pickers as the same pill, and locks the agent", () => {
  const base = {
    value: "hi",
    onChange: () => {},
    onSubmit: () => {},
    target: { jobName: "orchestrator", agentName: "orchestrator" },
    targetOptions: [
      { id: '["orchestrator","orchestrator"]', label: "orchestrator · orchestrator" },
      { id: '["poet"]', label: "poet" },
    ] as AssistantTargetOption[],
    onTargetChange: () => {},
    modelOptions: [{ ref: { providerId: "p", model: "flash" }, label: "Express · flash" }],
    onModelChange: () => {},
    onAttachFiles: () => {},
  };
  const html = renderToStaticMarkup(<AssistantComposer {...base} />);
  const trigger = (label: string) =>
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
  expect(trigger("Assistant agent")).toContain('data-slot="select-trigger"');
  expect(trigger("Model")).toContain('data-slot="select-trigger"');
  expect(trigger("Assistant agent")).toContain("rounded-full");
  expect(html).toContain("orchestrator · orchestrator");

  const locked = renderToStaticMarkup(<AssistantComposer {...base} targetLocked />);
  expect(locked.match(/<button[^>]*aria-label="Assistant agent"[^>]*>/)?.[0]).toMatch(
    /disabled=""|data-disabled/,
  );
});
