import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleArrowLeft,
  Box,
  Clock3,
  Database,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Terminal,
  Upload,
  Workflow,
  ChevronRight,
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { api, formatTime, taskTitle, timeAgo } from "@/lib/api";
import { useNav } from "@/lib/nav";

import {
  ContinueSession,
  RunBadge,
  DeleteSession,
  EventCard,
  LastOutput,
  PromptPreview,
  SessionStatsBar,
  TaskDocuments,
  useSessionStream,
} from "./session-parts";
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
  const { closeTask } = useNav();
  const runTask = useRunTask();
  const [tab, setTab] = useState("sessions");
  const [sessionId, setSessionId] = useState<string | null>(null);
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
    refetchInterval: (query) => (query.state.data?.run?.status === "running" ? 5000 : false),
  });
  useSessionStream(taskId, tab === "sessions" ? sessionId : null);
  const list = (sessions.data?.sessions ?? []).toSorted(
    (a, b) => b.lastUpdateTime - a.lastUpdateTime,
  );

  if (task.isPending) return <Loading label="Loading task…" />;
  if (task.isError) return <ErrorBox error={task.error} retry={() => void task.refetch()} />;
  const data = task.data;
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
        <span className="ml-auto flex items-center gap-1">
          <Button
            onClick={() => runTask.mutate(taskId)}
            disabled={!data.jobName || runTask.isPending}
          >
            {runTask.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            Run task
          </Button>
          <ConfirmDelete
            variant="outline"
            label="Delete task"
            question={`Delete this task${list.length ? ` and its ${list.length} session${list.length === 1 ? "" : "s"}` : ""}?`}
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
        <TabsContent value="sessions" className={sessionId ? sessionBody : paneBody}>
          {sessionId ? (
            <>
              <div className="-mx-6 flex items-center gap-2 border-b px-6 pb-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-primary -ml-1.5"
                  aria-label="All sessions"
                  title="All sessions"
                  onClick={() => setSessionId(null)}
                >
                  <CircleArrowLeft className="size-5" />
                </Button>
                {detail.data && (
                  <>
                    <h3 className="text-lg font-semibold">Session activity</h3>
                    <span className="text-muted-foreground text-sm">
                      {detail.data.events.length} events
                    </span>
                    <RunBadge run={detail.data.run} />
                    <span className="ml-auto flex">
                      <DeleteSession
                        taskId={taskId}
                        sessionId={detail.data.id}
                        onDeleted={() => setSessionId(null)}
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
                            <p className="text-muted-foreground flex items-center gap-1 text-xs">
                              <Clock3 className="size-3" />
                              Updated {formatTime(detail.data.lastUpdateTime)}
                            </p>
                            <Collapsible className="rounded-lg border p-2">
                              <CollapsibleTrigger className="flex w-full items-center gap-2 text-sm font-medium">
                                <Database className="size-4" />
                                Session state
                                <span className="text-muted-foreground ml-auto text-xs font-normal">
                                  {Object.keys(detail.data.state).length} keys
                                </span>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-2 text-xs">
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
                                <EventCard event={event} index={i} />
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
                  <ContinueSession
                    taskId={taskId}
                    sessionId={detail.data.id}
                    running={detail.data.run?.status === "running"}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Overline>Execution sessions</Overline>
                  <p className="text-muted-foreground text-sm">
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
              {sessions.isPending ? (
                <Loading label="Loading sessions…" />
              ) : sessions.isError ? (
                <ErrorBox error={sessions.error} retry={() => void sessions.refetch()} />
              ) : !list.length ? (
                <Empty icon={<Terminal />} title="The conversation starts with a run">
                  Run this task to create a session. New sessions appear automatically when the
                  agent starts.
                </Empty>
              ) : (
                list.map((session, i) => (
                  <button
                    key={session.id}
                    className="hover:bg-muted flex items-center gap-3 rounded-lg border p-3 text-left"
                    onClick={() => setSessionId(session.id)}
                  >
                    <span className="bg-primary/10 text-primary grid size-9 place-items-center rounded-lg">
                      <Terminal className="size-4" />
                    </span>
                    <span className="flex-1">
                      <strong className="block text-sm">{timeAgo(session.lastUpdateTime)}</strong>
                      <small className="text-muted-foreground">
                        {formatTime(session.lastUpdateTime)} · {session.id.slice(0, 8)}
                      </small>
                    </span>
                    <RunBadge run={session.run} />
                    {i === 0 && <Badge variant="secondary">Latest</Badge>}
                    <ChevronRight className="text-muted-foreground size-4" />
                  </button>
                ))
              )}
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
