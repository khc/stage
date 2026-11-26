import { Link } from "@tanstack/react-router";
import { CircleAlert, Workflow } from "lucide-react";

import {
  ReasoningTrace,
  SubagentTrace,
  ToolTrace,
  Trace,
  WorkingLine,
} from "@/components/agent-trace";
import { Markdown } from "@/components/markdown";
import { StageWordmark } from "@/components/stage-wordmark";
import { CopyButton } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { OutputText } from "@/features/tasks/session-parts";
import { parseJsonObject, type AgentInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  parseDelegation,
  targetLabel,
  turnCopyText,
  type AssistantTarget,
  type ChatTurn,
} from "./assistant-model";

const STARTER_PROMPTS = [
  "Summarize what agents and tools are available in this workspace.",
  "Help me break down a multi-step research question and delegate subtasks.",
  "Analyze the document I attach and highlight the key takeaways.",
  "Draft a structured action plan and explain each step clearly.",
];

// What the agent did in a turn: its thinking, then each tool call, as one Trace.
function Activity({
  turn,
  active,
}: {
  turn: Extract<ChatTurn, { kind: "assistant" }>;
  active?: boolean;
}) {
  if (!turn.tools.length && !turn.thoughts.length) return null;
  const waiting = !!active && !turn.textSegments.length;
  return (
    <Trace>
      {turn.thoughts.map((thought, i) => (
        <ReasoningTrace
          // Thoughts have no id and only grow at the end, so the index is a stable key.
          // oxlint-disable-next-line react/no-array-index-key
          key={`thought-${i}`}
          text={thought}
          running={waiting && !turn.tools.length && i === turn.thoughts.length - 1}
        />
      ))}
      {turn.tools.map((tool) => {
        const delegation = parseDelegation(tool.name);
        return delegation ? (
          <SubagentTrace
            key={tool.id}
            {...delegation}
            args={tool.args}
            response={tool.response}
            pending={tool.pending}
          />
        ) : (
          <ToolTrace
            key={tool.id}
            name={tool.name}
            args={tool.args}
            response={tool.response}
            pending={tool.pending}
          />
        );
      })}
    </Trace>
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
        <Spinner />
        Loading conversation…
      </div>
    );
  }

  if (!turns.length && !isRunning) {
    const defaultLabel = target ? targetLabel(target) : "orchestrator";
    return (
      <Empty className="min-h-0 [scrollbar-width:none] justify-center-safe overflow-y-auto px-4 md:px-6 [&::-webkit-scrollbar]:hidden">
        <EmptyMedia className="mb-0 w-full max-w-3xl" aria-hidden>
          <StageWordmark />
        </EmptyMedia>
        <EmptyHeader className="mt-12 sm:mt-26">
          <EmptyDescription>
            Start a conversation powered by{" "}
            <span className="font-medium text-foreground">{defaultLabel}</span> by default. Attach
            documents or switch agents anytime below.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-2xl">
          <div className="grid w-full gap-2 sm:grid-cols-2">
            {STARTER_PROMPTS.map((prompt) => (
              <Button
                key={prompt}
                variant="outline"
                className="h-auto justify-start py-2.5 text-left whitespace-normal"
                onClick={() => onStarterSelect(prompt)}
              >
                {prompt}
              </Button>
            ))}
          </div>
        </EmptyContent>
      </Empty>
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
                          <BubbleContent className="rounded-2xl px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap">
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
                    <img src="/stage.svg" alt="" aria-hidden className="size-6 shrink-0" />
                    <MessageContent className="gap-3 pt-0.75">
                      <Activity turn={turn} active={isLast && isRunning} />
                      {turn.textSegments.map((segment, segIdx) =>
                        parseJsonObject(segment) ? (
                          // Text segments have no id and only grow at the end, so the index is a stable key.
                          // oxlint-disable-next-line react/no-array-index-key
                          <OutputText key={segIdx} text={segment} schema={schema} />
                        ) : (
                          <Markdown
                            // oxlint-disable-next-line react/no-array-index-key
                            key={segIdx}
                            className={cn(
                              "text-base leading-relaxed text-foreground",
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
                  <img src="/stage.svg" alt="" aria-hidden className="size-6 shrink-0" />
                  <MessageContent>
                    <Trace>
                      <WorkingLine label="Working on it" />
                    </Trace>
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
