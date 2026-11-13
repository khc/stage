import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUp,
  Check,
  Clock3,
  Loader2,
  Terminal,
  Upload,
  FileText,
  Workflow,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConfirmDelete } from "@/components/confirm-delete";
import { JsonView } from "@/components/json-view";
import { Markdown } from "@/components/markdown";
import { Empty, ErrorBox, Loading, Overline } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import {
  api,
  formatTime,
  lastOutput,
  parseJsonObject,
  streamMessages,
  withEvent,
  type DocumentSummary,
  type JsonSchema,
  type RunState,
  type Session,
  type SessionEvent,
  type SessionSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Keeps the cached session in step with the live message stream.
export function useSessionStream(taskId: string, sessionId: string | null) {
  const client = useQueryClient();
  useEffect(() => {
    if (!sessionId) return;
    return streamMessages(taskId, sessionId, (event) =>
      client.setQueryData<Session>(
        ["session", taskId, sessionId],
        (old) => old && withEvent(old, event),
      ),
    );
  }, [client, taskId, sessionId]);
}

function Preview({ children, wrap = true }: { children: ReactNode; wrap?: boolean }) {
  return (
    <div className={cn("rounded-lg border bg-muted/40 p-3 text-sm", wrap && "whitespace-pre-wrap")}>
      {children}
    </div>
  );
}

const runBadge = {
  running: { label: "Running", variant: "secondary" },
  succeeded: { label: "Succeeded", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
} as const;

export function RunBadge({ run }: { run?: RunState }) {
  if (!run) return null;
  const { label, variant } = runBadge[run.status];
  return (
    <Badge variant={variant} title={run.error}>
      {run.status === "running" && <Loader2 className="animate-spin" />}
      {label}
    </Badge>
  );
}

export function SessionStatsBar({
  taskId,
  sessionId,
  events,
}: {
  taskId: string;
  sessionId: string;
  events: number;
}) {
  // The event count in the key refetches the totals as live events arrive.
  const stats = useQuery({
    queryKey: ["session-stats", taskId, sessionId, events],
    queryFn: () => api.stats(taskId, sessionId),
    placeholderData: (previous) => previous,
  });
  if (!stats.data) return null;
  const { tokens, llmCalls } = stats.data;
  const items: [string, number][] = [
    ["Total", tokens.total],
    ["Prompt", tokens.prompt],
    ["Output", tokens.candidates],
    ["Thinking", tokens.thoughts],
    ["Model calls", llmCalls],
  ];
  return (
    <dl
      className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3"
      aria-label="Token usage"
    >
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl border bg-muted/30 px-3 py-2.5">
          <dt className="text-[0.65rem] font-semibold tracking-wider text-muted-foreground uppercase">
            {label}
          </dt>
          <dd className="text-xl font-medium">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DeleteSession({
  taskId,
  sessionId,
  onDeleted,
}: {
  taskId: string;
  sessionId: string;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  return (
    <ConfirmDelete
      variant="outline"
      label="Delete session"
      question="Delete this session?"
      remove={() => api.deleteSession(taskId, sessionId)}
      onDeleted={() => {
        onDeleted();
        client.removeQueries({ queryKey: ["session", taskId, sessionId] });
        void client.invalidateQueries({ queryKey: ["sessions", taskId] });
      }}
    />
  );
}

export function ContinueSession({
  taskId,
  sessionId,
  running = false,
}: {
  taskId: string;
  sessionId: string;
  running?: boolean;
}) {
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const resume = useMutation({
    mutationFn: () => api.resume(taskId, sessionId, message.trim()),
    onSuccess: () => {
      setMessage("");
      void client.invalidateQueries({ queryKey: ["session", taskId, sessionId] });
    },
  });
  const canSend = !!message.trim() && !resume.isPending && !running;
  return (
    <form
      className="-mx-6 flex shrink-0 flex-col gap-1 border-t px-6 pt-3 pb-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) resume.mutate();
      }}
    >
      <InputGroup className="rounded-3xl border-transparent bg-muted dark:bg-muted">
        <InputGroupTextarea
          className="max-h-40 min-h-0 resize-none p-3"
          aria-label="Message to continue the session"
          rows={2}
          value={message}
          maxLength={10_000}
          placeholder="Message the agent…"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            className="ml-auto rounded-full"
            aria-label="Send message"
            disabled={!canSend}
          >
            {resume.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {resume.isError ? (
        <p className="text-xs text-destructive" role="alert">
          {resume.error.message}
        </p>
      ) : resume.isSuccess ? (
        <p className="text-xs text-muted-foreground" role="status">
          Sent. New events appear when the agent responds.
        </p>
      ) : running ? (
        <p className="text-xs text-muted-foreground" role="status">
          The agent is still running. You can reply when it finishes.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
      )}
    </form>
  );
}

// The saved prompt: a JSON object is shown as a tree, anything else as text.
export function PromptPreview({ text }: { text: string }) {
  const value = parseJsonObject(text);
  return value ? (
    <Preview wrap={false}>
      <JsonView value={value} />
    </Preview>
  ) : (
    <Preview>{text}</Preview>
  );
}

const isMarkdown = (schema?: JsonSchema) => /markdown/i.test(schema?.description ?? "");

function OutputText({ text, schema }: { text: string; schema?: JsonSchema }) {
  const fields = parseJsonObject(text);
  if (!fields)
    return isMarkdown(schema) ? (
      <Preview wrap={false}>
        <Markdown>{text}</Markdown>
      </Preview>
    ) : (
      <Preview>{text}</Preview>
    );
  return (
    <dl className="flex flex-col gap-3">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key} className="flex flex-col gap-1">
          <dt>
            <Overline>{key}</Overline>
          </dt>
          <dd>
            {typeof value === "string" && isMarkdown(schema?.properties?.[key]) ? (
              <Preview wrap={false}>
                <Markdown>{value}</Markdown>
              </Preview>
            ) : typeof value === "object" && value !== null ? (
              <Preview wrap={false}>
                <JsonView value={value} />
              </Preview>
            ) : (
              <Preview>{typeof value === "string" ? value : JSON.stringify(value)}</Preview>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LastOutput({
  taskId,
  latest,
  loading,
  onOpen,
  jobName,
  agentName,
}: {
  taskId: string;
  jobName?: string;
  agentName?: string;
  latest?: SessionSummary;
  loading: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const sessionId = latest?.id ?? null;
  const agents = useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName!),
    enabled: !!jobName,
    retry: false,
  });
  const agent = agents.data?.agents.find((candidate) => candidate.name === agentName);
  const session = useQuery({
    queryKey: ["session", taskId, sessionId],
    queryFn: () => api.session(taskId, sessionId!),
    enabled: !!sessionId,
  });
  useSessionStream(taskId, sessionId);
  if (loading || (sessionId && session.isPending)) return <Loading label="Loading output…" />;
  if (!latest)
    return (
      <Empty icon={<Terminal />} title="No output yet">
        Run this task to create a session. Its last answer appears here.
      </Empty>
    );
  if (session.isError)
    return <ErrorBox error={session.error} retry={() => void session.refetch()} />;
  const output = lastOutput(session.data!.events);
  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Last output</h3>
        <Button variant="link" size="sm" onClick={() => onOpen(latest.id)}>
          View session
          <ArrowRight />
        </Button>
      </div>
      {output ? (
        <>
          <OutputText text={output.text} schema={agent?.outputSchema} />
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="size-3" />
            {formatTime(output.timestamp ?? latest.lastUpdateTime)}
          </p>
        </>
      ) : (
        <Empty icon={<Terminal />} title="No answer yet">
          The latest session has not produced a text answer. It may still be running.
        </Empty>
      )}
    </>
  );
}

export function TaskDocuments({
  taskId,
  query,
}: {
  taskId: string;
  query: {
    isPending: boolean;
    isError: boolean;
    error: Error | null;
    data?: { documents: DocumentSummary[] };
    refetch: () => unknown;
  };
}) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["documents", taskId] });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadDocument(taskId, file),
    onSuccess: refresh,
  });
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div>
          <Overline>Documents</Overline>
          <p className="text-sm text-muted-foreground">
            Uploaded files are extracted to text and attached to this task.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          hidden
          aria-label="Choose a document"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) upload.mutate(file);
          }}
        />
        <Button size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
          {upload.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
          Upload
        </Button>
      </div>
      {upload.isError && <ErrorBox error={upload.error} />}
      {query.isPending ? (
        <Loading label="Loading documents…" />
      ) : query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : !query.data?.documents.length ? (
        <Empty icon={<FileText />} title="No documents yet">
          Upload a file to make its extracted content available to this task.
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {query.data.documents.map((doc) => (
            <div key={doc.documentId} className="flex items-center gap-3 rounded-lg border p-3">
              <FileText className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{doc.filename}</strong>
                <small className="text-muted-foreground">{doc.contentType}</small>
              </span>
              <ConfirmDelete
                label="Remove document"
                question="Remove this document?"
                remove={() => api.deleteDocument(taskId, doc.documentId)}
                onDeleted={() => void refresh()}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ToolEvent({
  icon,
  name,
  data,
  open,
}: {
  icon: React.ReactNode;
  name: string;
  data: unknown;
  open?: boolean;
}) {
  return (
    <Collapsible defaultOpen={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {name}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <JsonView className="overflow-x-auto rounded-md bg-muted p-2" value={data} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function EventCard({ event, index }: { event: SessionEvent; index: number }) {
  const parts = event.content?.parts ?? [];
  const isUser = event.author === "user";
  const align = isUser ? "end" : "start";
  return (
    <Message align={align}>
      <MessageContent>
        <MessageHeader className={cn("gap-2", isUser && "justify-end")}>
          <strong className="font-medium text-primary capitalize">
            {event.author ?? event.content?.role ?? "Event"}
          </strong>
          <span className="font-normal">
            {event.timestamp ? formatTime(event.timestamp) : `Event ${index + 1}`}
          </span>
        </MessageHeader>
        <Bubble
          align={align}
          variant={event.errorMessage ? "destructive" : isUser ? "tinted" : "ghost"}
        >
          <BubbleContent className="flex flex-col gap-2">
            {event.errorMessage && <p>{event.errorMessage}</p>}
            {parts.map((part, i) => (
              // Parts have no id and never reorder, so their position is the key.
              // oxlint-disable-next-line react/no-array-index-key
              <div key={i} className="flex flex-col gap-1">
                {part.text != null &&
                  (part.thought || !parseJsonObject(part.text) ? (
                    <div
                      className={cn(
                        "text-[13px] leading-relaxed whitespace-pre-wrap",
                        part.thought && "text-muted-foreground italic",
                      )}
                    >
                      {part.thought && (
                        <span className="mr-1 text-xs font-semibold uppercase">Reasoning</span>
                      )}
                      {part.text}
                    </div>
                  ) : (
                    <OutputText text={part.text} />
                  ))}
                {part.functionCall && (
                  <ToolEvent
                    open
                    icon={<Workflow className="size-3.5" />}
                    name={part.functionCall.name ?? "Tool call"}
                    data={part.functionCall.args ?? {}}
                  />
                )}
                {part.functionResponse && (
                  <ToolEvent
                    icon={<Check className="size-3.5" />}
                    name={part.functionResponse.name ?? "Tool response"}
                    data={part.functionResponse.response ?? {}}
                  />
                )}
              </div>
            ))}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="px-0">
          <ToolEvent icon={null} name="Raw event" data={event} />
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}
