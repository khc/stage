import { Box, ChevronRight, Plus, Server, Workflow } from "lucide-react";

import { CopyButton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortJobName, type Job } from "@/lib/api";
import { useNav } from "@/lib/nav";

import { RegisterAgentsButton, useAgentRegistration } from "./agents";

export const jobLocation = (job: Job) => job.name?.split("/locations/")[1]?.split("/")[0];

export function JobCard({ job }: { job: Job }) {
  const { openJob, openCreate } = useNav();
  const name = shortJobName(job);
  const { agents, register } = useAgentRegistration(name, !!job.name);
  const taskCount = job.template?.taskCount;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-lg">
            <Server className="size-5" />
          </span>
          <Button variant="ghost" size="sm" onClick={() => void openJob(name)}>
            Details
            <ChevronRight />
          </Button>
        </div>
        <CardTitle>
          <button className="hover:underline" onClick={() => void openJob(name)}>
            {name}
          </button>
        </CardTitle>
        <CardDescription>
          {job.description || "An agent worker available for task execution."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">
            <Box />
            {jobLocation(job) ?? "Cloud Run"}
          </Badge>
          {taskCount != null && (
            <span>
              {taskCount} task{taskCount === 1 ? "" : "s"} per execution
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Registered agents">
          {agents.length ? (
            agents.map((agent) => (
              <Badge
                key={agent.name}
                variant="secondary"
                className="font-mono"
                title={agent.description}
              >
                <Workflow />
                {agent.name}
              </Badge>
            ))
          ) : (
            <small className="text-muted-foreground">No agents registered yet</small>
          )}
        </div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
          <code className="truncate">{job.name ?? "Resource name unavailable"}</code>
          {job.name && <CopyButton value={job.name} label="Copy resource name" />}
        </div>
        <RegisterAgentsButton register={register} disabled={!job.name} />
        <Button variant="outline" className="w-full" onClick={() => void openCreate(name)}>
          <Plus />
          Create task for this job
        </Button>
      </CardContent>
    </Card>
  );
}
