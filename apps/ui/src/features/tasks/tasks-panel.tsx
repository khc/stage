import {
  Box,
  ChevronRight,
  FileText,
  Layers3,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Workflow,
} from "lucide-react";
import { useState } from "react";

import { Empty, ErrorBox, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { taskTitle } from "@/lib/api";
import { useNav } from "@/lib/nav";
import { usePlatformLive } from "@/lib/platform-events";
import { useTasks } from "@/lib/queries";

import { useRunTask } from "./use-run-task";

export function TasksPanel({ title }: { title: string }) {
  const tasksQuery = useTasks();
  const runTask = useRunTask();
  const { openTask, openCreate } = useNav();
  const live = usePlatformLive();
  const [search, setSearch] = useState("");
  const tasks = tasksQuery.data?.tasks ?? [];
  const filtered = tasks.filter((task) =>
    `${task.name ?? ""} ${task.prompt} ${task.jobName} ${task.agentName ?? ""} ${task.taskId}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 pb-4">
        <CardTitle className="flex items-center gap-2">
          <Layers3 className="size-4" />
          {title}
          {tasksQuery.data && <Badge variant="secondary">{tasks.length}</Badge>}
        </CardTitle>
        <div className="relative w-64 max-w-full">
          <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input
            data-search
            aria-label="Search tasks"
            placeholder="Search tasks…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {tasksQuery.isPending ? (
          <Loading label="Loading tasks…" />
        ) : tasksQuery.isError ? (
          <div className="px-4">
            <ErrorBox error={tasksQuery.error} retry={() => void tasksQuery.refetch()} />
          </div>
        ) : !tasks.length ? (
          <Empty
            icon={<Layers3 />}
            title="Your next idea starts here"
            action={
              <Button size="sm" onClick={() => void openCreate()}>
                <Plus />
                Create a task
              </Button>
            }
          >
            Save a prompt and choose a job to get started.
          </Empty>
        ) : !filtered.length ? (
          <Empty icon={<Search />} title="No matching tasks">
            Try another prompt, job name, or task ID.
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Task</TableHead>
                <TableHead className="hidden md:table-cell">Job</TableHead>
                <TableHead className="hidden md:table-cell">Agent</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((task) => (
                <TableRow
                  key={task.taskId}
                  className="cursor-pointer"
                  onClick={() => void openTask(task.taskId)}
                >
                  <TableCell className="max-w-xs pl-4">
                    <button
                      className="flex items-center gap-2 text-left"
                      onClick={() => void openTask(task.taskId)}
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <strong className="line-clamp-1 font-medium">{taskTitle(task)}</strong>
                        {task.name?.trim() && task.prompt.trim() !== "{}" && (
                          <small className="line-clamp-1 hidden text-muted-foreground md:block">
                            {task.prompt}
                          </small>
                        )}
                        <small className="text-muted-foreground md:hidden">
                          {task.jobName ?? "Needs job"}
                          {task.agentName ? ` · ${task.agentName}` : ""}
                        </small>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant={task.jobName ? "outline" : "destructive"} className="font-mono">
                      <Box />
                      {task.jobName ?? "Needs job"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant={task.agentName ? "secondary" : "outline"} className="font-mono">
                      <Workflow />
                      {task.agentName ?? "Default"}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="hidden md:inline-flex"
                        onClick={() => void openTask(task.taskId)}
                      >
                        Details
                        <ChevronRight />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!task.jobName || runTask.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          runTask.mutate(task.taskId);
                        }}
                        aria-label={`Run task ${task.taskId}`}
                      >
                        {runTask.isPending && runTask.variables === task.taskId ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Play />
                        )}
                        Run
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CardFooter className="justify-between text-xs text-muted-foreground">
        <span>
          {tasksQuery.data
            ? `${filtered.length} task${filtered.length === 1 ? "" : "s"}`
            : "Task workspace"}
        </span>
        <span className="flex items-center gap-1">
          <RefreshCw className="size-3" />
          {live ? "Live updates" : "Refreshes every 15 seconds"}
        </span>
      </CardFooter>
    </Card>
  );
}
