import { Brain, Check, Workflow, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { Markdown } from "@/components/markdown";
import { Overline } from "@/components/states";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

// The agent-step rows of a turn (Reasoning, Tool), built on Trace so each step has one shape.
export { Trace };

export function JsonCode({ value }: { value: unknown }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockContent wrap className="max-h-64">
        {typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null")}
      </CodeBlockContent>
    </CodeBlock>
  );
}

export function WorkingLine({ label = "Working" }: { label?: string }) {
  return (
    <TraceLine status="running">
      <TraceTitle>{label}</TraceTitle>
    </TraceLine>
  );
}

export function ReasoningTrace({
  text,
  running = false,
  defaultOpen,
}: {
  text: string;
  running?: boolean;
  defaultOpen?: boolean;
}) {
  const line = (
    <TraceLine status={running ? "running" : undefined}>
      <TraceIcon>
        <Brain />
      </TraceIcon>
      <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
    </TraceLine>
  );
  if (!text.trim()) return line;
  return (
    <TraceCollapsible defaultOpen={defaultOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export function ToolTrace({
  name,
  args,
  response,
  pending = false,
  defaultOpen,
  icon,
  label,
  description,
}: {
  name: string;
  args?: unknown;
  response?: unknown;
  pending?: boolean;
  defaultOpen?: boolean;
  icon?: ReactNode;
  label?: string;
  description?: string;
}) {
  const title = label ?? `${pending ? "Calling" : "Called"} ${name}`;
  const line = (
    <TraceLine status={pending ? "running" : undefined}>
      <TraceIcon>{icon ?? (response !== undefined ? <Check /> : <Wrench />)}</TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {description && <TraceDescription>{description}</TraceDescription>}
    </TraceLine>
  );
  if (args === undefined && response === undefined) return line;
  return (
    <TraceCollapsible defaultOpen={defaultOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {args !== undefined && <JsonCode value={args} />}
        {response !== undefined && <JsonCode value={response} />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

// The one string a request or result carries, if it is just that: `"text"` or `{ key: "text" }`.
const plainText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const values = Object.values(value);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
};

function Section({
  label,
  value,
  markdown,
}: {
  label: string;
  value: unknown;
  markdown?: boolean;
}) {
  const text = plainText(value);
  return (
    <div className="flex flex-col gap-1.5">
      <Overline>{label}</Overline>
      {text === undefined ? (
        <JsonCode value={value} />
      ) : markdown ? (
        <Markdown className="text-sm">{text}</Markdown>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{text}</p>
      )}
    </div>
  );
}

// An agent handed work to another agent: the line is the run, and it opens to what it was asked and found.
export function SubagentTrace({
  job,
  agent,
  args,
  response,
  pending = false,
}: {
  job: string;
  agent: string;
  args?: unknown;
  response?: unknown;
  pending?: boolean;
}) {
  const line = (
    <TraceLine status={pending ? "running" : undefined}>
      <TraceIcon>{pending ? <Workflow /> : <Check />}</TraceIcon>
      <TraceTitle>
        {pending ? "Delegating to" : "Delegated to"} {agent}
      </TraceTitle>
      <TraceDescription>{job}</TraceDescription>
    </TraceLine>
  );
  if (args === undefined && response === undefined) return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-3">
        {args !== undefined && <Section label="Request" value={args} />}
        {response !== undefined && <Section label="Result" value={response} markdown />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
