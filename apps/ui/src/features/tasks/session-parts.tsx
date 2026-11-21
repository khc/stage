import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUp, Box, Clock3, FileText, Terminal, Upload, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ReasoningTrace, ToolTrace, Trace } from "@/components/agent-trace";
import { ConfirmDelete } from "@/components/confirm-delete";
import { JsonView } from "@/components/json-view";
import { Markdown } from "@/components/markdown";
import { Empty, ErrorBox, Loading, Overline } from "@/components/states";
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/features/models/model-picker";
import {
  api,
  formatTime,
  lastOutput,
  parseJsonObject,
  quickServiceName,
  streamMessages,
  withEvent,
  type AgentInfo,
  type DocumentSummary,
  type JsonSchema,
  type ModelRef,
  type RunState,
  type Session,
  type SessionEvent,
  type SessionSummary,
} from "@/lib/api";
import { modelOptions, pickedModel, type ModelPick } from "@/lib/models";
import { useProviders } from "@/lib/queries";
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
      {run.status === "running" && <Spinner />}
      {label}
    </Badge>
  );
}

// Where a run was hosted: a quick run on the job's service, a workflow run as the job itself.
export function RunHostBadge({ run, jobName }: { run?: RunState; jobName?: string }) {
  if (!run?.mode || !jobName) return null;
  const quick = run.mode === "quick";
  return (
    <Badge
      variant="outline"
      className="font-mono"
      title={quick ? "Quick run on the agent service" : "Workflow run as a Cloud Run job"}
    >
      {quick ? <Zap /> : <Box />}
      {quick ? quickServiceName(jobName) : jobName}
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
          <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
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

export const sessionRefetchInterval = (
  session: Pick<Session, "run" | "events"> | undefined,
  awaitingRun: boolean,
): number | false => {
  if (session?.run?.status === "running") return 5000;
  if (awaitingRun && !session?.run) return 2000;
  return false;
};

export const freeTextInputHint = (schema?: JsonSchema): string | undefined =>
  schema?.type !== undefined && schema.type !== "string"
    ? "This agent expects structured input. Use Run task instead."
    : undefined;

export function SessionComposer({
  taskId,
  sessionId,
  running = false,
  disabled = false,
  disabledReason,
  defaultModel,
  onStarted,
}: {
  taskId: string;
  sessionId?: string;
  // The task's default model; the picker starts on it.
  defaultModel?: ModelRef;
  running?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onStarted?: (sessionId: string) => void;
}) {
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const [modelPick, setModelPick] = useState<ModelPick | null>(null);
  const models = modelOptions(useProviders().data?.providers ?? []);
  const model = pickedModel(modelPick, taskId, models, defaultModel);
  const send = useMutation({
    mutationFn: () =>
      sessionId
        ? api.resume(taskId, sessionId, message.trim(), model)
        : api.startSession(taskId, message.trim(), model),
    onSuccess: (result) => {
      setMessage("");
      if (sessionId) {
        void client.invalidateQueries({ queryKey: ["session", taskId, sessionId] });
      } else {
        void client.invalidateQueries({ queryKey: ["sessions", taskId] });
        if (result.sessionId) onStarted?.(result.sessionId);
      }
    },
  });
  const blocked = running || disabled;
  const canSend = !!message.trim() && !send.isPending && !blocked;
  const blockedMessage = running
    ? "The agent is still running. You can reply when it finishes."
    : disabledReason;
  return (
    <form
      className="-mx-6 flex shrink-0 flex-col gap-1 border-t px-6 pt-3 pb-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) send.mutate();
      }}
    >
      <InputGroup className="rounded-3xl bg-card shadow-sm">
        <InputGroupTextarea
          className="max-h-40 min-h-0 resize-none p-3"
          aria-label={
            sessionId ? "Message to continue the session" : "Message to start a new session"
          }
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
          {models.length > 0 && (
            <ModelPicker
              compact
              options={models}
              value={model}
              onChange={(next) => setModelPick({ key: taskId, model: next })}
              // A session that exists already has messages.
              hasHistory={!!sessionId}
              disabled={send.isPending}
            />
          )}
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            className="ml-auto rounded-full"
            aria-label="Send message"
            disabled={!canSend}
          >
            {send.isPending ? <Spinner /> : <ArrowUp />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {send.isError ? (
        <p className="text-xs text-destructive" role="alert">
          {send.error.message}
        </p>
      ) : send.isSuccess ? (
        <p className="text-xs text-muted-foreground" role="status">
          Sent. New events appear when the agent responds.
        </p>
      ) : blockedMessage ? (
        <p className="text-xs text-muted-foreground" role="status">
          {blockedMessage}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> for a new line
        </p>
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

// An agent that declares its output a plain string (and not Markdown) is shown as written. Any
// other agent text that is not a JSON object, such as a chat reply that skips the output schema,
// is Markdown: models write it that way.
const isPlainText = (schema?: JsonSchema) => schema?.type === "string" && !isMarkdown(schema);

export function OutputText({ text, schema }: { text: string; schema?: JsonSchema }) {
  const fields = parseJsonObject(text);
  if (!fields)
    return isPlainText(schema) ? (
      <Preview>{text}</Preview>
    ) : (
      <Preview wrap={false}>
        <Markdown>{text}</Markdown>
      </Preview>
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

// The agents of a job image, which tell how their output is laid out (for example which
// fields are Markdown).
export const useJobAgents = (jobName?: string) =>
  useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName!),
    enabled: !!jobName,
    retry: false,
  });

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
  const agents = useJobAgents(jobName);
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
  // A task that names no agent runs the job's default one, which is the author of its events.
  const agent = agents.data?.agents.find(
    (candidate) => candidate.name === (agentName ?? output?.author),
  );
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
          {upload.isPending ? <Spinner /> : <Upload />}
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
            <Attachment key={doc.documentId} className="w-full">
              <AttachmentMedia>
                <FileText />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{doc.filename}</AttachmentTitle>
                <AttachmentDescription>{doc.contentType}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <ConfirmDelete
                  label="Remove document"
                  question="Remove this document?"
                  remove={() => api.deleteDocument(taskId, doc.documentId)}
                  onDeleted={() => void refresh()}
                />
              </AttachmentActions>
            </Attachment>
          ))}
        </div>
      )}
    </>
  );
}

export function EventCard({
  event,
  index,
  agents,
}: {
  event: SessionEvent;
  index: number;
  agents?: AgentInfo[];
}) {
  const parts = event.content?.parts ?? [];
  const outputSchema = agents?.find((agent) => agent.name === event.author)?.outputSchema;
  const isUser = event.author === "user";
  const textAsMarkdown = !isUser && !isPlainText(outputSchema);
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
                  (part.thought ? (
                    <Trace>
                      <ReasoningTrace text={part.text} />
                    </Trace>
                  ) : !parseJsonObject(part.text) ? (
                    textAsMarkdown ? (
                      <Markdown className="text-sm">{part.text}</Markdown>
                    ) : (
                      <div className="text-sm leading-relaxed whitespace-pre-wrap">{part.text}</div>
                    )
                  ) : (
                    <OutputText text={part.text} schema={outputSchema} />
                  ))}
                {part.functionCall && (
                  <Trace>
                    <ToolTrace
                      defaultOpen
                      name={part.functionCall.name ?? "Tool call"}
                      args={part.functionCall.args ?? {}}
                    />
                  </Trace>
                )}
                {part.functionResponse && (
                  <Trace>
                    <ToolTrace
                      name={part.functionResponse.name ?? "Tool response"}
                      label={`Result of ${part.functionResponse.name ?? "tool"}`}
                      response={part.functionResponse.response ?? {}}
                    />
                  </Trace>
                )}
              </div>
            ))}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="px-0">
          <Trace>
            <ToolTrace name="Raw event" label="Raw event" icon={<Terminal />} response={event} />
          </Trace>
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}
