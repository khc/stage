import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleArrowLeft,
  Box,
  Clock3,
  Database,
  FileText,
  Play,
  RefreshCw,
  Sparkles,
  Terminal,
  Upload,
  Workflow,
  ChevronRight,
  CornerDownRight,
} from "lucide-react";
import { useState } from "react";

import { ConfirmDelete } from "@/components/confirm-delete";
import { PaneHeader, PaneTab, PaneTabsList, TabCount, paneBody } from "@/components/pane";
import { ResizableSheetContent } from "@/components/resizable-sheet";
import { Empty, ErrorBox, IdLine, Loading, Overline } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { api, formatTime, taskTitle, timeAgo } from "@/lib/api";
import { useNav } from "@/lib/nav";
import { useTasks } from "@/lib/queries";

import {
  SessionComposer,
  RunBadge,
  DeleteSession,
  EventCard,
  LastOutput,
  useJobAgents,
  PromptPreview,
  SessionStatsBar,
  TaskDocuments,
  freeTextInputHint,
  sessionRefetchInterval,
  useSessionStream,
} from "./session-parts";
import { countDescendants } from "./task-tree";
import { useRunTask } from "./use-run-task";

// The open session fills the pane: the thread scrolls and the composer stays below it.
const sessionBody = "flex min-h-0 flex-col overflow-hidden px-6 pt-2";

export function TaskSheet({ taskId }: { taskId?: string }) {
  const { closeTask } = useNav();
  return (
    <Sheet open={!!taskId} onOpenChange={(open) => !open && void closeTask()}>
      <ResizableSheetContent label="task details" className="gap-0 data-[side=right]:sm:w-[42rem]">
        {taskId && <TaskDetails key={taskId} taskId={taskId} />}
      </ResizableSheetContent>
    </Sheet>
  );
}

function TaskDetails({ taskId }: { taskId: string }) {
  const client = useQueryClient();
  const { closeTask, openTask } = useNav();
  const runTask = useRunTask();
  const [tab, setTab] = useState("sessions");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const closeSession = () => {
    setSessionId(null);
    setStartingId(null);
  };
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  const sessions = useQuery({
    queryKey: ["sessions", taskId],
    queryFn: () => api.sessions(taskId),
    enabled: !!task.data,
    refetchInterval: (query) =>
      tab === "output" || query.state.data?.sessions.some((s) => s.run?.status === "running")
        ? 5000
        : false,
  });
  const documents = useQuery({
    queryKey: ["documents", taskId],
    queryFn: () => api.documents(taskId),
    enabled: !!task.data,
  });
  const detail = useQuery({
    queryKey: ["session", taskId, sessionId],
    queryFn: () => api.session(taskId, sessionId!),
    enabled: !!sessionId,
    refetchInterval: (query) =>
      sessionRefetchInterval(query.state.data, !!sessionId && sessionId === startingId),
  });
  const agents = useJobAgents(task.data?.jobName);
  // The delete question names the sub-tasks, so it waits for the task list.
  const tasksQuery = useTasks();
  const allTasks = tasksQuery.data?.tasks ?? [];
  useSessionStream(taskId, tab === "sessions" ? sessionId : null);
  const list = (sessions.data?.sessions ?? []).toSorted(
    (a, b) => b.lastUpdateTime - a.lastUpdateTime,
  );

  if (task.isPending) return <Loading label="Loading task…" />;
  if (task.isError) return <ErrorBox error={task.error} retry={() => void task.refetch()} />;
  const data = task.data;
  const parent = allTasks.find((candidate) => candidate.taskId === data.parentTaskId);
  const subTasks = countDescendants(allTasks, taskId);
  const registeredAgents = agents.data?.agents ?? [];
  const startInputHint = !data.jobName
    ? "Assign a job before messaging the agent."
    : data.agentName
      ? freeTextInputHint(registeredAgents.find((a) => a.name === data.agentName)?.inputSchema)
      : registeredAgents.length && registeredAgents.every((a) => freeTextInputHint(a.inputSchema))
        ? freeTextInputHint(registeredAgents[0]?.inputSchema)
        : undefined;
  return (
    <>
      <PaneHeader eyebrow="TASK DETAILS" icon={<FileText />} title={taskTitle(data)} id={taskId}>
        <Badge variant="outline" className="font-mono">
          <Box />
          {data.jobName ?? "Unassigned job"}
        </Badge>
        <Badge variant={data.agentName ? "secondary" : "outline"} title="Agent that runs this task">
          <Workflow />
          {data.agentName ?? "Default agent"}
        </Badge>
        {data.parentTaskId && (
          <Button
            variant="outline"
            size="sm"
            title="The task that delegated this one"
            onClick={() => void openTask(data.parentTaskId!)}
          >
            <CornerDownRight />
            Sub-task of {parent ? taskTitle(parent) : data.parentTaskId.slice(0, 8)}
          </Button>
        )}
        {subTasks > 0 && (
          <Badge variant="secondary" title="Tasks that this one delegated, and theirs">
            {subTasks} sub-task{subTasks === 1 ? "" : "s"}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-4">
          <Button
            onClick={() => runTask.mutate(taskId)}
            disabled={!data.jobName || runTask.isPending}
          >
            {runTask.isPending ? <Spinner /> : <Play />}
            Run task
          </Button>
          <ConfirmDelete
            variant="outline"
            label="Delete task"
            disabled={!tasksQuery.isSuccess}
            question={`Delete this task${list.length ? ` and its ${list.length} session${list.length === 1 ? "" : "s"}` : ""}${subTasks ? `${list.length ? "," : ""} and its ${subTasks} sub-task${subTasks === 1 ? "" : "s"} with their sessions` : ""}?`}
            remove={() => api.deleteTask(taskId)}
            onDeleted={() => {
              client.removeQueries({ queryKey: ["task", taskId] });
              client.removeQueries({ queryKey: ["sessions", taskId] });
              void client.invalidateQueries({ queryKey: ["tasks"] });
              void closeTask();
            }}
          />
        </span>
      </PaneHeader>
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <PaneTabsList>
          <PaneTab value="sessions">
            <Terminal />
            Sessions <TabCount>{list.length}</TabCount>
          </PaneTab>
          <PaneTab value="output">
            <Sparkles />
            Output
          </PaneTab>
          <PaneTab value="prompt">
            <FileText />
            Prompt
          </PaneTab>
          <PaneTab value="documents">
            <Upload />
            Documents <TabCount>{documents.data?.documents.length ?? 0}</TabCount>
          </PaneTab>
        </PaneTabsList>
        <TabsContent value="sessions" className={sessionBody}>
          {sessionId ? (
            <>
              <div className="-mx-6 flex items-center gap-2 border-b px-6 pb-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-1.5 text-primary"
                  aria-label="All sessions"
                  title="All sessions"
                  onClick={closeSession}
                >
                  <CircleArrowLeft className="size-5" />
                </Button>
                {detail.data && (
                  <>
                    <h3 className="min-w-0 truncate text-lg font-semibold">
                      {detail.data.name ?? "Session activity"}
                    </h3>
                    <span className="text-sm text-muted-foreground">
                      {detail.data.events.length} events
                    </span>
                    <RunBadge run={detail.data.run} />
                    <span className="ml-auto flex">
                      <DeleteSession
                        taskId={taskId}
                        sessionId={detail.data.id}
                        onDeleted={closeSession}
                      />
                    </span>
                  </>
                )}
              </div>
              {detail.isPending ? (
                <div className="pt-4">
                  <Loading label="Loading session…" />
                </div>
              ) : detail.isError ? (
                <div className="pt-4">
                  <ErrorBox error={detail.error} retry={() => void detail.refetch()} />
                </div>
              ) : (
                <>
                  <MessageScrollerProvider autoScroll>
                    <MessageScroller className="-mx-6 w-auto flex-1">
                      <MessageScrollerViewport className="[scrollbar-width:none]! [scrollbar-gutter:auto]! [&::-webkit-scrollbar]:hidden">
                        <MessageScrollerContent className="px-6 py-4">
                          <MessageScrollerItem
                            messageId="session-info"
                            className="flex flex-col gap-4"
                          >
                            <IdLine value={detail.data.id} />
                            <SessionStatsBar
                              taskId={taskId}
                              sessionId={detail.data.id}
                              events={detail.data.events.length}
                            />
                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock3 className="size-3" />
                              Updated {formatTime(detail.data.lastUpdateTime)}
                            </p>
                            <Collapsible className="rounded-lg border p-2">
                              <CollapsibleTrigger className="flex w-full items-center gap-2 text-sm font-medium">
                                <Database className="size-4" />
                                Session state
                                <span className="ml-auto text-xs font-normal text-muted-foreground">
                                  {Object.keys(detail.data.state).length} keys
                                </span>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">
                                  {JSON.stringify(detail.data.state, null, 2)}
                                </pre>
                              </CollapsibleContent>
                            </Collapsible>
                          </MessageScrollerItem>
                          {detail.data.events.length ? (
                            detail.data.events.map((event, i) => (
                              <MessageScrollerItem
                                key={event.id ?? i}
                                messageId={event.id ?? String(i)}
                                scrollAnchor={event.author === "user"}
                              >
                                <EventCard event={event} index={i} agents={agents.data?.agents} />
                              </MessageScrollerItem>
                            ))
                          ) : (
                            <Empty icon={<Terminal />} title="No events yet">
                              Events will appear here as the agent works.
                            </Empty>
                          )}
                        </MessageScrollerContent>
                      </MessageScrollerViewport>
                      <MessageScrollerButton />
                    </MessageScroller>
                  </MessageScrollerProvider>
                  <SessionComposer
                    taskId={taskId}
                    sessionId={detail.data.id}
                    running={detail.data.run?.status === "running"}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2 pt-3 pb-2">
                <div>
                  <Overline>Execution sessions</Overline>
                  <p className="text-sm text-muted-foreground">
                    Each attempt has its own conversation.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void sessions.refetch()}
                  aria-label="Refresh sessions"
                  disabled={sessions.isFetching}
                >
                  <RefreshCw className={sessions.isFetching ? "animate-spin" : ""} />
                </Button>
              </div>
              <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-3">
                {sessions.isPending ? (
                  <Loading label="Loading sessions…" />
                ) : sessions.isError ? (
                  <ErrorBox error={sessions.error} retry={() => void sessions.refetch()} />
                ) : !list.length ? (
                  <Empty icon={<Terminal />} title="The conversation starts with a run">
                    Run this task or send a message below to start a session. New sessions appear
                    automatically when the agent starts.
                  </Empty>
                ) : (
                  list.map((session, i) => (
                    <button
                      key={session.id}
                      className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted"
                      onClick={() => setSessionId(session.id)}
                    >
                      <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Terminal className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">
                          {session.name ?? timeAgo(session.lastUpdateTime)}
                        </strong>
                        <small className="text-muted-foreground">
                          {session.name ? `${timeAgo(session.lastUpdateTime)} · ` : ""}
                          {formatTime(session.lastUpdateTime)} · {session.id.slice(0, 8)}
                        </small>
                      </span>
                      <RunBadge run={session.run} />
                      {i === 0 && <Badge variant="secondary">Latest</Badge>}
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </button>
                  ))
                )}
              </div>
              <SessionComposer
                taskId={taskId}
                disabled={!!startInputHint}
                disabledReason={startInputHint}
                onStarted={(newId) => {
                  setStartingId(newId);
                  setSessionId(newId);
                }}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="output" className={paneBody}>
          <LastOutput
            taskId={taskId}
            jobName={data.jobName}
            agentName={data.agentName}
            latest={list[0]}
            loading={sessions.isPending}
            onOpen={(id) => {
              setSessionId(id);
              setTab("sessions");
            }}
          />
        </TabsContent>
        <TabsContent value="prompt" className={paneBody}>
          <Overline>Saved prompt</Overline>
          <PromptPreview text={data.prompt} />
        </TabsContent>
        <TabsContent value="documents" className={paneBody}>
          <TaskDocuments taskId={taskId} query={documents} />
        </TabsContent>
      </Tabs>
    </>
  );
}
