import { Link } from "@tanstack/react-router";
import { ChevronDown, CircleAlert, Loader2, Wrench, Workflow } from "lucide-react";

import { JsonView } from "@/components/json-view";
import { Markdown } from "@/components/markdown";
import { CopyButton } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { OutputText } from "@/features/tasks/session-parts";
import { parseJsonObject, type AgentInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

import { turnCopyText, type AssistantTarget, type ChatTurn } from "./assistant-model";

const STARTER_PROMPTS = [
  "Summarize what agents and tools are available in this workspace.",
  "Help me break down a multi-step research question and delegate subtasks.",
  "Analyze the document I attach and highlight the key takeaways.",
  "Draft a structured action plan and explain each step clearly.",
];

function ActivityDisclosure({
  turn,
  active,
}: {
  turn: Extract<ChatTurn, { kind: "assistant" }>;
  active?: boolean;
}) {
  const stepCount = turn.tools.length + turn.thoughts.length;
  if (!stepCount) return null;
  const hasPendingTool = turn.tools.some((tool) => tool.pending);
  const label =
    hasPendingTool || (active && !turn.textSegments.length)
      ? `Working · ${turn.tools.at(-1)?.name ?? "thinking"}…`
      : turn.tools.length
        ? `Activity · ${turn.tools.length} tool ${turn.tools.length === 1 ? "call" : "calls"}${turn.thoughts.length ? ` · ${turn.thoughts.length} notes` : ""}`
        : `Reasoning (${turn.thoughts.length})`;

  return (
    <Collapsible className="w-fit max-w-full rounded-xl border bg-muted/30 text-xs">
      <CollapsibleTrigger className="group flex h-[30px] items-center gap-2 px-3 font-medium text-muted-foreground hover:text-foreground">
        {hasPendingTool || (active && !turn.textSegments.length) ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : (
          <Wrench className="size-3.5 text-muted-foreground" />
        )}
        <span>{label}</span>
        <ChevronDown className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2.5 border-t px-3 py-2.5">
        {turn.thoughts.map((thought, i) => (
          <p key={`thought-${i}`} className="leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
            {thought}
          </p>
        ))}
        {turn.tools.map((tool) => (
          <div key={tool.id} className="flex flex-col gap-1.5 rounded-lg border bg-background/70 p-2">
            <div className="flex items-center gap-2">
              <Badge variant={tool.pending ? "secondary" : "outline"} className="font-mono text-[11px]">
                {tool.pending && <Loader2 className="size-3 animate-spin" />}
                {tool.name}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {tool.pending ? "Running" : "Completed"}
              </span>
            </div>
            {tool.args !== undefined && (
              <JsonView className="overflow-x-auto rounded bg-muted/60 p-1.5" value={tool.args} />
            )}
            {tool.response !== undefined && (
              <JsonView className="overflow-x-auto rounded bg-muted/60 p-1.5" value={tool.response} />
            )}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AssistantThread({
  turns,
  agents,
  target,
  isRunning,
  isLoadingSession,
  childCount = 0,
  taskId,
  onStarterSelect,
}: {
  turns: ChatTurn[];
  agents?: AgentInfo[];
  target?: AssistantTarget;
  isRunning?: boolean;
  isLoadingSession?: boolean;
  childCount?: number;
  taskId?: string;
  onStarterSelect: (prompt: string) => void;
}) {
  if (isLoadingSession) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading conversation…
      </div>
    );
  }

  if (!turns.length && !isRunning) {
    const defaultLabel = target
      ? target.agentName
        ? `${target.agentName} (${target.jobName})`
        : target.jobName
      : "orchestrator";
    return (
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
        <div className="flex w-full max-w-2xl flex-col items-center gap-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <img
              src="/stage.png"
              alt="Stage Assistant"
              className="size-12 rounded-2xl shadow-sm"
            />
            <h2 className="font-display text-5xl tracking-tight sm:text-6xl">
              How can I help today?
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Start a conversation powered by{" "}
              <span className="font-medium text-foreground">{defaultLabel}</span> by default. Attach
              documents or switch agents anytime below.
            </p>
          </div>
          <div className="grid w-full gap-2.5 text-left sm:grid-cols-2">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onStarterSelect(prompt)}
                className="group rounded-2xl border bg-card/70 p-3.5 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent/50"
              >
                <span className="line-clamp-2 leading-relaxed">{prompt}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const lastTurn = turns.at(-1);
  const showWorkingIndicator =
    isRunning && (!lastTurn || lastTurn.kind === "user" || !lastTurn.textSegments.length);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport className="[scrollbar-width:none]! [scrollbar-gutter:auto]! [&::-webkit-scrollbar]:hidden">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 md:px-6">
            {childCount > 0 && taskId && (
              <div className="flex items-center justify-center">
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId }}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <Workflow className="size-3.5 text-primary" />
                  {childCount} delegated {childCount === 1 ? "subtask" : "subtasks"} · Inspect in
                  Tasks
                </Link>
              </div>
            )}
            {turns.map((turn, index) => {
              const isLast = index === turns.length - 1;
              if (turn.kind === "user") {
                return (
                  <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor>
                    <Message align="end">
                      <MessageContent>
                        <Bubble align="end" variant="tinted">
                          <BubbleContent className="rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                            {turn.text}
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                );
              }

              const schema = agents?.find((a) => a.name === turn.author)?.outputSchema;
              const copyValue = turnCopyText(turn);
              return (
                <MessageScrollerItem key={turn.id} messageId={turn.id}>
                  <Message align="start" className="items-start gap-3">
                    <img
                      src="/stage.png"
                      alt=""
                      aria-hidden
                      className="size-8 shrink-0 rounded-xl shadow-xs"
                    />
                    <MessageContent className="gap-3">
                      <ActivityDisclosure turn={turn} active={isLast && isRunning} />
                      {turn.textSegments.map((segment, segIdx) =>
                        parseJsonObject(segment) ? (
                          <OutputText key={segIdx} text={segment} schema={schema} />
                        ) : (
                          <Markdown
                            key={segIdx}
                            className={cn(
                              "text-[15px] leading-relaxed text-foreground",
                              "[&_p]:my-2.5 [&_pre]:rounded-xl [&_pre]:p-3",
                            )}
                          >
                            {segment}
                          </Markdown>
                        ),
                      )}
                      {turn.errorMessage && (
                        <Alert variant="destructive">
                          <CircleAlert />
                          <AlertTitle>Assistant error</AlertTitle>
                          <AlertDescription>{turn.errorMessage}</AlertDescription>
                        </Alert>
                      )}
                      {copyValue && (
                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
                          <CopyButton value={copyValue} label="Copy response" />
                        </div>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
            {showWorkingIndicator && (
              <MessageScrollerItem messageId="assistant-working">
                <Message align="start" className="items-center gap-3">
                  <span
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15"
                  >
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                  <MessageContent>
                    <span className="text-sm text-muted-foreground">Working on it…</span>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
