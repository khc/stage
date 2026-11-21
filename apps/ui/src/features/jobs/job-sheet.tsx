import { Box, Database, FileText, Plus, Server, Workflow } from "lucide-react";

import { PaneHeader, PaneTab, PaneTabsList, TabCount, paneBody } from "@/components/pane";
import { ResizableSheetContent } from "@/components/resizable-sheet";
import { Empty, ErrorBox, Loading, Overline } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { jobDetails, jobEnvNames, shortJobName, type Job, type Task } from "@/lib/api";
import { useNav } from "@/lib/nav";

import {
  AgentContract,
  RegisterAgentsButton,
  RegisterAgentsNote,
  useAgentRegistration,
} from "./agents";
import { jobLocation } from "./jobs-table";

export function JobSheet({ job, tasks }: { job?: Job; tasks: Task[] }) {
  const { closeJob, openCreate, openTask } = useNav();
  return (
    <Sheet open={!!job} onOpenChange={(open) => !open && void closeJob()}>
      <ResizableSheetContent label="job details" className="gap-0 data-[side=right]:sm:w-[36rem]">
        {job && (
          <JobDetails
            job={job}
            tasks={tasks}
            onCreate={() => void openCreate(shortJobName(job))}
            onOpenTask={(id) => void openTask(id)}
          />
        )}
      </ResizableSheetContent>
    </Sheet>
  );
}

function JobDetails({
  job,
  tasks,
  onCreate,
  onOpenTask,
}: {
  job: Job;
  tasks: Task[];
  onCreate: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const name = shortJobName(job);
  const { agents, query, register } = useAgentRegistration(name, !!job.name);
  const jobTasks = tasks.filter((task) => task.jobName === name);
  const envNames = jobEnvNames(job);
  const status = jobDetails(job).find(([label]) => label === "Status")?.[1];
  return (
    <>
      <PaneHeader
        eyebrow="JOB DETAILS"
        icon={<Server />}
        title={name}
        id={job.name ?? "Resource name unavailable"}
      >
        <Badge variant="outline">
          <Box />
          {jobLocation(job) ?? "Cloud Run"}
        </Badge>
        {status && (
          <Badge variant={status === "Ready" ? "secondary" : "destructive"}>{status}</Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          <RegisterAgentsButton register={register} disabled={!job.name} />
          <Button onClick={onCreate}>
            <Plus />
            Create task
          </Button>
        </span>
        <div className="basis-full empty:hidden">
          <RegisterAgentsNote register={register} />
        </div>
      </PaneHeader>
      <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0">
        <PaneTabsList>
          <PaneTab value="overview">
            <Database />
            Overview
          </PaneTab>
          <PaneTab value="agents">
            <Workflow />
            Agents <TabCount>{agents.length}</TabCount>
          </PaneTab>
          <PaneTab value="tasks">
            <FileText />
            Tasks <TabCount>{jobTasks.length}</TabCount>
          </PaneTab>
        </PaneTabsList>
        <TabsContent value="overview" className={paneBody}>
          <div className="shrink-0 overflow-hidden rounded-lg border">
            <Table className="table-fixed">
              <TableBody>
                {jobDetails(job).map(([label, value]) => (
                  <TableRow key={label}>
                    <TableCell className="w-[40%] text-muted-foreground">{label}</TableCell>
                    <TableCell className="break-all whitespace-normal">{value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Overline>Environment variables</Overline>
          {envNames.length ? (
            <EnvTable names={envNames} />
          ) : (
            <small className="text-muted-foreground">None set.</small>
          )}
        </TabsContent>
        <TabsContent value="agents" className={paneBody}>
          <p className="text-sm text-muted-foreground">
            The agents inside this job&apos;s container.
          </p>
          {query.isError ? (
            <ErrorBox error={query.error} retry={() => void query.refetch()} />
          ) : query.isPending ? (
            <Loading label="Loading agents…" />
          ) : !agents.length ? (
            <Empty icon={<Workflow />} title="No agents registered">
              Register this job to record the agents in its container.
            </Empty>
          ) : (
            agents.map((agent) => (
              <article key={agent.name} className="flex flex-col gap-2 rounded-lg border p-3">
                <h3 className="flex items-center gap-1.5 font-medium">
                  <Workflow className="size-3.5" />
                  {agent.name}
                </h3>
                {agent.description && (
                  <p className="text-sm text-muted-foreground">{agent.description}</p>
                )}
                <AgentContract agent={agent} />
              </article>
            ))
          )}
        </TabsContent>
        <TabsContent value="tasks" className={paneBody}>
          {!jobTasks.length ? (
            <Empty icon={<FileText />} title="No tasks yet">
              Create a task for this job to see it here.
            </Empty>
          ) : (
            jobTasks.map((task) => (
              <button
                key={task.taskId}
                className="flex flex-col rounded-lg border p-3 text-left hover:bg-muted"
                onClick={() => onOpenTask(task.taskId)}
              >
                <strong className="line-clamp-2 text-sm">{task.prompt}</strong>
                <small className="text-muted-foreground">
                  {task.agentName ?? "Default agent"} · …{task.taskId.slice(-6)}
                </small>
              </button>
            ))
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

// Only the names: the service never sends the values.
function EnvTable({ names }: { names: string[] }) {
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {names.map((name) => (
            <TableRow key={name}>
              <TableCell className="font-mono text-xs">{name}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
