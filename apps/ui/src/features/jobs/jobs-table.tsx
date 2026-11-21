import { createColumnHelper, useTable } from "@tanstack/react-table";
import { Box, ChevronRight, Plus, RefreshCw, Search, Server, Workflow } from "lucide-react";
import { useMemo, useState } from "react";

import { CopyButton, Empty, ErrorBox, Loading } from "@/components/states";
import {
  ariaSort,
  features,
  SortHeader,
  type DataTableFeatures,
} from "@/components/data-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortJobName, type Job } from "@/lib/api";
import { useNav } from "@/lib/nav";
import { useJobs, useTasks } from "@/lib/queries";

import { RegisterAgentsButton, RegisterAgentsNote, useAgentRegistration } from "./agents";

export const jobLocation = (job: Job) => job.name?.split("/locations/")[1]?.split("/")[0];

type JobRow = { job: Job; name: string; location: string; tasks: number };

const columnHelper = createColumnHelper<DataTableFeatures, JobRow>();
const NAME = "name";
const MOBILE_HIDDEN = new Set(["location", "tasks", "agents"]);

function JobName({ row }: { row: JobRow }) {
  const { openJob } = useNav();
  return (
    <Item size="xs" className="p-0">
      <ItemMedia variant="icon" className="rounded-lg bg-primary/10 p-2 text-primary">
        <Server />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          <button
            type="button"
            className="truncate hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              void openJob(row.name);
            }}
          >
            {row.name}
          </button>
        </ItemTitle>
        <ItemDescription className="flex min-w-0 items-center gap-1 text-xs">
          <code className="truncate">{row.job.name ?? "Resource name unavailable"}</code>
          {row.job.name && <CopyButton value={row.job.name} label="Copy resource name" />}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

function JobAgents({ row }: { row: JobRow }) {
  const { agents } = useAgentRegistration(row.name, !!row.job.name);
  return agents.length ? (
    <div className="flex flex-wrap gap-1" aria-label="Registered agents">
      {agents.map((agent) => (
        <Badge key={agent.name} variant="secondary" className="font-mono" title={agent.description}>
          <Workflow />
          {agent.name}
        </Badge>
      ))}
    </div>
  ) : (
    <small className="text-muted-foreground">No agents registered yet</small>
  );
}

function JobActions({ row }: { row: JobRow }) {
  const { openJob, openCreate } = useNav();
  const { register } = useAgentRegistration(row.name, !!row.job.name);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1 max-md:flex-col max-md:items-stretch">
        <Button
          variant="ghost"
          size="sm"
          className="max-md:hidden"
          onClick={(e) => {
            e.stopPropagation();
            void openJob(row.name);
          }}
        >
          Details
          <ChevronRight />
        </Button>
        <RegisterAgentsButton register={register} disabled={!row.job.name} variant="ghost" />
        <Button
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            void openCreate(row.name);
          }}
        >
          <Plus />
          Create task
        </Button>
      </div>
      <RegisterAgentsNote register={register} />
    </div>
  );
}

const columns = columnHelper.columns([
  columnHelper.accessor("name", {
    id: NAME,
    header: ({ column }) => <SortHeader column={column} title="Job" />,
    sortFn: "text",
    cell: ({ row }) => <JobName row={row.original} />,
  }),
  columnHelper.accessor("location", {
    id: "location",
    header: ({ column }) => <SortHeader column={column} title="Region" />,
    sortFn: "text",
    cell: ({ getValue }) => (
      <Badge variant="outline" className="font-mono">
        <Box />
        {getValue()}
      </Badge>
    ),
  }),
  columnHelper.accessor("tasks", {
    id: "tasks",
    header: ({ column }) => <SortHeader column={column} title="Tasks" />,
    sortFn: "alphanumeric",
    cell: ({ getValue }) => <span className="tabular-nums">{getValue()}</span>,
  }),
  columnHelper.display({
    id: "agents",
    header: "Agents",
    cell: ({ row }) => <JobAgents row={row.original} />,
  }),
  columnHelper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => <JobActions row={row.original} />,
  }),
]);

export function JobsTable() {
  const jobsQuery = useJobs();
  const tasksQuery = useTasks();
  const { openJob } = useNav();
  const [search, setSearch] = useState("");
  const jobs = jobsQuery.data?.jobs;
  const tasks = tasksQuery.data?.tasks;
  const data = useMemo<JobRow[]>(() => {
    const counts = new Map<string, number>();
    for (const task of tasks ?? []) if (task.jobName) counts.set(task.jobName, (counts.get(task.jobName) ?? 0) + 1);
    return (jobs ?? []).map((job) => {
      const name = shortJobName(job);
      return { job, name, location: jobLocation(job) ?? "Cloud Run", tasks: counts.get(name) ?? 0 };
    });
  }, [jobs, tasks]);
  const table = useTable({
    features,
    data,
    columns,
    getRowId: (row, index) => row.job.name ?? String(index),
    globalFilterFn: (row, _columnId, query: string) =>
      row.original.name.toLowerCase().includes(query.trim().toLowerCase()),
    getColumnCanGlobalFilter: (column) => column.id === NAME,
    state: { globalFilter: search },
  });
  const rows = table.getRowModel().rows;
  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 pb-4">
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" />
          Cloud Run jobs
          <Badge variant="secondary">{data.length}</Badge>
        </CardTitle>
        <SearchInput label="Search jobs" value={search} onChange={setSearch} />
      </CardHeader>
      <CardContent className="px-0">
        {jobsQuery.isPending ? (
          <Loading label="Loading jobs…" />
        ) : jobsQuery.isError ? (
          <div className="px-4">
            <ErrorBox error={jobsQuery.error} retry={() => void jobsQuery.refetch()} />
          </div>
        ) : !data.length ? (
          <Empty icon={<Server />} title="No jobs configured">
            Create a Cloud Run job in the configured project and region, then refresh this
            workspace.
          </Empty>
        ) : !rows.length ? (
          <Empty icon={<Search />} title="No matching jobs">
            Try another job name.
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
                          : header.column.id === NAME
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
                  onClick={() => void openJob(row.original.name)}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={
                        MOBILE_HIDDEN.has(cell.column.id)
                          ? "hidden md:table-cell"
                          : cell.column.id === NAME
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
      <CardFooter className="justify-between text-xs text-muted-foreground">
        <span>
          {jobsQuery.data
            ? search
              ? `${rows.length} matching`
              : `${rows.length} of ${data.length} jobs shown`
            : "Job workspace"}
        </span>
        <span className="flex items-center gap-1">
          <RefreshCw className="size-3" />
          Refreshes every 15 seconds
        </span>
      </CardFooter>
    </Card>
  );
}
