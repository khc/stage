import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentInfo, SessionEvent } from "@/lib/api";

import {
  EventCard,
  OutputText,
  RunHostBadge,
  SessionComposer,
  freeTextInputHint,
  sessionRefetchInterval,
} from "./session-parts";

const agents: AgentInfo[] = [
  {
    name: "knowledge-assistant",
    inputSchema: { type: "string" },
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "The answer as Markdown." },
        sources: { type: "array", items: { type: "string" } },
      },
    },
  },
];

const event = (author: string): SessionEvent => ({
  author,
  content: {
    role: "model",
    parts: [
      {
        text: JSON.stringify({
          answer: "Use **Bun.file()**:\n\n```ts\nconst a = 1;\n```",
          sources: [],
        }),
      },
    ],
  },
});

test("a session event answer is rendered as Markdown using the schema of its author's agent", () => {
  const html = renderToStaticMarkup(
    <EventCard event={event("knowledge-assistant")} index={0} agents={agents} />,
  );

  expect(html).toContain("<strong>Bun.file()</strong>");
  expect(html).toContain("<pre");
  expect(html).not.toContain("**Bun.file()**");
});

test("an event of an agent without a Markdown field stays plain text", () => {
  const html = renderToStaticMarkup(
    <EventCard event={event("someone-else")} index={0} agents={agents} />,
  );

  expect(html).toContain("**Bun.file()**");
});

const reply = "Sources:\n\n*   `bun`\n*   `duckdb`";
const textEvent = (author: string, text = reply): SessionEvent => ({
  author,
  content: { role: author === "user" ? "user" : "model", parts: [{ text }] },
});
const plainAgent: AgentInfo = {
  name: "assistant",
  outputSchema: { type: "string", description: "The assistant's plain-text reply." },
};

test("a plain-text reply of an agent whose output is a JSON object is rendered as Markdown", () => {
  const html = renderToStaticMarkup(
    <EventCard event={textEvent("knowledge-assistant")} index={0} agents={agents} />,
  );

  expect(html).toContain("<li");
  expect(html).toContain("<code");
  expect(html).not.toContain("`bun`");
});

test("a reply of an agent that is not listed is rendered as Markdown too", () => {
  const html = renderToStaticMarkup(<EventCard event={textEvent("unknown")} index={0} />);

  expect(html).toContain("<li");
  expect(html).not.toContain("`bun`");
});

test("user messages and replies of a plain-string agent stay plain text", () => {
  const user = renderToStaticMarkup(
    <EventCard event={textEvent("user")} index={0} agents={agents} />,
  );
  const plain = renderToStaticMarkup(
    <EventCard event={textEvent("assistant")} index={0} agents={[plainAgent]} />,
  );

  for (const html of [user, plain]) {
    expect(html).toContain("`bun`");
    expect(html).not.toContain("<li");
  }
});

test("the Output tab renders non-JSON text as Markdown unless the agent's output is a plain string", () => {
  const rendered = renderToStaticMarkup(<OutputText text={reply} />);
  const plain = renderToStaticMarkup(<OutputText text={reply} schema={plainAgent.outputSchema} />);

  expect(rendered).toContain("<li");
  expect(plain).toContain("`bun`");
  expect(plain).not.toContain("<li");
});

test("SessionComposer renders the message textarea for starting or continuing a session", () => {
  const client = new QueryClient();
  const listComposer = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SessionComposer taskId="t1" />
    </QueryClientProvider>,
  );
  const blockedComposer = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SessionComposer
        taskId="t1"
        sessionId="s1"
        disabled
        disabledReason="Assign a job before messaging the agent."
      />
    </QueryClientProvider>,
  );

  expect(listComposer).toContain("Message the agent…");
  expect(listComposer).toContain("Message to start a new session");
  expect(blockedComposer).toContain("Message to continue the session");
  expect(blockedComposer).toContain("Assign a job before messaging the agent.");
});

test("sessionRefetchInterval polls running or newly started sessions and stops when settled", () => {
  expect(sessionRefetchInterval({ events: [] }, true)).toBe(2000);
  expect(
    sessionRefetchInterval({ events: [], run: { status: "running", startedAt: 1 } }, false),
  ).toBe(5000);
  expect(
    sessionRefetchInterval({ events: [], run: { status: "succeeded", startedAt: 1 } }, true),
  ).toBe(false);
  expect(sessionRefetchInterval({ events: [] }, false)).toBe(false);
});

test("freeTextInputHint blocks non-string agent schemas for new user-message sessions", () => {
  expect(freeTextInputHint({ type: "string" })).toBeUndefined();
  expect(freeTextInputHint(undefined)).toBeUndefined();
  expect(freeTextInputHint({ type: "object", properties: {} })).toContain("structured input");
});

test("the task message box starts on the task default model and offers the usable models", () => {
  const providerId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";
  const client = new QueryClient();
  client.setQueryData(["providers"], {
    providers: [
      {
        providerId,
        name: "Express",
        kind: "google-express",
        enabled: true,
        hasApiKey: true,
        models: ["flash", "pro"],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  const render = (defaultModel?: { providerId: string; model: string }) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SessionComposer taskId="t1" sessionId="s1" defaultModel={defaultModel} />
      </QueryClientProvider>,
    );
  expect(render({ providerId, model: "pro" })).toContain("Express · pro");
  // A default that is no longer offered is not preselected.
  expect(render({ providerId, model: "gone" })).toContain("Job default");
  expect(render()).toContain('aria-label="Model"');
});

test("RunHostBadge names the service for a quick run and the job for a workflow run", () => {
  const job = "stage--knowledge-agents--job-lcl";
  const quick = renderToStaticMarkup(
    <RunHostBadge run={{ status: "succeeded", startedAt: 1, mode: "quick" }} jobName={job} />,
  );
  const workflow = renderToStaticMarkup(
    <RunHostBadge run={{ status: "succeeded", startedAt: 1, mode: "workflow" }} jobName={job} />,
  );
  expect(quick).toContain("stage--knowledge-agents--svc-lcl");
  expect(quick).not.toContain(job);
  expect(workflow).toContain(job);
  expect(renderToStaticMarkup(<RunHostBadge run={{ status: "succeeded", startedAt: 1 }} jobName={job} />)).toBe("");
});
