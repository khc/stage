import { Link } from "@tanstack/react-router";
import { createColumnHelper, useTable, type ExpandedState } from "@tanstack/react-table";
import {
  Box,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FileText,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  Search,
  Workflow,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  ariaSort,
  features,
  SortHeader,
  TablePagination,
  type DataTableFeatures,
} from "@/components/data-table";
import { SearchInput } from "@/components/search-input";
import { Empty, ErrorBox, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
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

import { buildTaskForest, rowMatches, type TaskNode } from "./task-tree";
import { useRunTask } from "./use-run-task";

const columnHelper = createColumnHelper<DataTableFeatures, TaskNode>();

const TITLE = "title";
const MOBILE_HIDDEN = new Set(["job", "agent"]);
// A sub-task is indented a step per level, up to this many levels.
const MAX_INDENT = 8;

function RunButton({ task }: { task: TaskNode }) {
  const runTask = useRunTask();
  return (
    <span title={task.jobName ? undefined : "Assign a job to run this task"}>
      <Button
        variant="outline"
        size="sm"
        disabled={!task.jobName || runTask.isPending}
        onClick={(e) => {
          e.stopPropagation();
          runTask.mutate(task.taskId);
        }}
        aria-label={`Run task ${taskTitle(task)}${task.jobName ? "" : " (needs a job)"}`}
      >
        {runTask.isPending ? <Spinner /> : <Play />}
        Run
      </Button>
    </span>
  );
}

const columns = columnHelper.columns([
  columnHelper.accessor((task) => taskTitle(task), {
    id: TITLE,
    header: ({ column }) => <SortHeader column={column} title="Task" />,
    sortFn: "text",
    cell: ({ row, table }) => {
      const task = row.original;
      const open = row.getIsExpanded();
      // A search opens every sub-task it found, so the toggle does nothing while it is active.
      const searching = !!table.options.state?.globalFilter;
      return (
        <div
          className="flex min-w-0 items-center gap-1"
          style={{ paddingLeft: Math.min(row.depth, MAX_INDENT) * 20 }}
        >
          {row.getCanExpand() && !searching ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 max-md:size-8"
              aria-expanded={open}
              aria-label={open ? "Hide sub-tasks" : "Show sub-tasks"}
              onClick={(e) => {
                e.stopPropagation();
                row.getToggleExpandedHandler()();
              }}
            >
              {open ? <ChevronDown /> : <ChevronRight />}
            </Button>
          ) : (
            <span className="size-6 shrink-0 max-md:size-8" />
          )}
          {/* The row click is a mouse shortcut; this button is the keyboard stop. */}
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {row.depth > 0 ? (
              <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <strong className="block truncate font-medium">{taskTitle(task)}</strong>
              {task.name?.trim() && task.prompt.trim() !== "{}" && (
                <small className="hidden truncate text-muted-foreground md:block">
                  {task.prompt}
                </small>
              )}
              <small className="block truncate text-muted-foreground md:hidden">
                {task.jobName ?? "Needs job"}
                {task.agentName ? ` · ${task.agentName}` : ""}
              </small>
            </span>
          </button>
        </div>
      );
    },
  }),
  columnHelper.accessor((task) => task.jobName ?? "", {
    id: "job",
    header: ({ column }) => <SortHeader column={column} title="Job" />,
    sortFn: "text",
    cell: ({ row }) => (
      <Badge variant={row.original.jobName ? "outline" : "destructive"} className="font-mono">
        <Box />
        {row.original.jobName ?? "Needs job"}
      </Badge>
    ),
  }),
  columnHelper.accessor((task) => task.agentName ?? "", {
    id: "agent",
    header: ({ column }) => <SortHeader column={column} title="Agent" />,
    sortFn: "text",
    cell: ({ row }) => (
      <Badge variant={row.original.agentName ? "secondary" : "outline"} className="font-mono">
        <Workflow />
        {row.original.agentName ?? "Default"}
      </Badge>
    ),
  }),
  columnHelper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => (
      <div className="flex justify-end">
        <RunButton task={row.original} />
      </div>
    ),
  }),
]);

// `limit` caps the rows shown (the overview) and links to the full list; without it the table pages.
export function TasksPanel({ title, limit }: { title: string; limit?: number }) {
  const tasksQuery = useTasks();
  const { openTask, openCreate } = useNav();
  const live = usePlatformLive();
  const [search, setSearch] = useState("");
  // Sub-tasks sit under the task that caused them and start collapsed.
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const tasks = tasksQuery.data?.tasks;
  const forest = useMemo(() => buildTaskForest(tasks ?? []), [tasks]);
  const table = useTable({
    features,
    data: forest,
    columns,
    getRowId: (task) => task.taskId,
    getSubRows: (task) => task.subTasks,
    filterFromLeafRows: true,
    globalFilterFn: (row, _columnId, query: string) => rowMatches(row, query),
    getColumnCanGlobalFilter: (column) => column.id === TITLE,
    // A search opens every sub-task it found.
    state: { globalFilter: search, expanded: search ? true : expanded },
    onExpandedChange: setExpanded,
    initialState: { pagination: { pageIndex: 0, pageSize: limit ?? 10 } },
    paginateExpandedRows: false,
    // The overview shows one page; a search shows every match instead of hiding the rest.
    manualPagination: !!limit && !!search,
  });
  const rows = table.getRowModel().rows;
  const total = tasks?.length ?? 0;
  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 pb-4">
        <CardTitle className="flex items-center gap-2">
          <Layers3 className="size-4" />
          {title}
          {tasksQuery.data && <Badge variant="secondary">{total}</Badge>}
        </CardTitle>
        <SearchInput label="Search tasks" value={search} onChange={setSearch} />
      </CardHeader>
      <CardContent className="px-0">
        {tasksQuery.isPending ? (
          <Loading label="Loading tasks…" />
        ) : tasksQuery.isError ? (
          <div className="px-4">
            <ErrorBox error={tasksQuery.error} retry={() => void tasksQuery.refetch()} />
          </div>
        ) : !total ? (
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
        ) : !rows.length ? (
          <Empty icon={<Search />} title="No matching tasks">
            Try another prompt, job name, or task ID.
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      aria-sort={ariaSort(header.column.getIsSorted())}
                      className={
                        MOBILE_HIDDEN.has(header.column.id)
                          ? "hidden md:table-cell"
                          : header.column.id === TITLE
                            ? "pl-4"
                            : "pr-4"
                      }
                    >
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => void openTask(row.original.taskId)}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={
                        MOBILE_HIDDEN.has(cell.column.id)
                          ? "hidden md:table-cell"
                          : cell.column.id === TITLE
                            ? "max-w-xs pl-4"
                            : "pr-4"
                      }
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {tasksQuery.data
            ? search
              ? `${rows.length} matching`
              : `${rows.length} of ${total} tasks shown`
            : "Task workspace"}
          {limit && !search && table.getPageCount() > 1 && (
            <Link to="/tasks" className="text-primary hover:underline">
              View all
            </Link>
          )}
        </span>
        {!limit && <TablePagination table={table} />}
        <span className="flex items-center gap-1">
          <RefreshCw className="size-3" />
          {live ? "Live updates" : "Refreshes every 15 seconds"}
        </span>
      </CardFooter>
    </Card>
  );
}
