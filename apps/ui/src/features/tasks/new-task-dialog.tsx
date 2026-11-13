import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Layers3, Loader2, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ErrorBox, Overline } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AgentContract } from "@/features/jobs/agents";
import {
  api,
  buildPrompt,
  inputExample,
  promptError,
  schemaFields,
  shortJobName,
  takesNoInput,
  type FormValues,
  type Job,
} from "@/lib/api";
import { useNav } from "@/lib/nav";
import { useJobs } from "@/lib/queries";

import { SchemaField } from "./schema-field";

const DEFAULT_AGENT = "__default";

export function NewTaskDialog({ open, initialJob }: { open: boolean; initialJob: string }) {
  const { closeCreate } = useNav();
  const jobs = useJobs().data?.jobs ?? [];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && void closeCreate()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <NewTaskForm jobs={jobs} initialJob={initialJob} onClose={() => void closeCreate()} />
      </DialogContent>
    </Dialog>
  );
}

function NewTaskForm({
  jobs,
  initialJob,
  onClose,
}: {
  jobs: Job[];
  initialJob: string;
  onClose: () => void;
}) {
  const { openTask } = useNav();
  const [prompt, setPrompt] = useState("");
  const [jobName, setJobName] = useState(initialJob);
  const [agentName, setAgentName] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const registered = useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName),
    enabled: !!jobName,
    retry: false,
  });
  const jobAgents = registered.data?.agents ?? [];
  const selectedAgent = jobAgents.find((agent) => agent.name === agentName);
  // A structured agent gets a form; its values are sent as the JSON prompt.
  const fields = schemaFields(selectedAgent?.inputSchema);
  const built = fields ? buildPrompt(fields, values) : undefined;
  const noInput = takesNoInput(selectedAgent?.inputSchema);
  const effectivePrompt = noInput ? "{}" : built ? ("prompt" in built ? built.prompt : "") : prompt;
  const touched = Object.values(values).some((v) => v !== "" && v !== false);
  const promptProblem = built
    ? "error" in built && touched
      ? built.error
      : undefined
    : promptError(selectedAgent?.inputSchema, prompt);
  const invalid = built ? "error" in built : !!promptProblem;
  const jobOptions = [
    ...new Set([...jobs.filter((job) => job.name).map(shortJobName), jobName].filter(Boolean)),
  ];
  const mutation = useMutation({
    mutationFn: api.create,
    onSuccess: (task) => {
      onClose();
      toast.success("Task created", {
        description: "Your prompt is saved. Run it when you’re ready.",
      });
      void openTask(task.taskId);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate({
      prompt: effectivePrompt.trim(),
      jobName,
      agentName: agentName.trim() || undefined,
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <span className="bg-primary/10 text-primary mb-1 grid size-9 place-items-center rounded-lg">
          <Layers3 className="size-5" />
        </span>
        <DialogTitle>Create a task</DialogTitle>
        <DialogDescription>A prompt, a worker, and room to do great work.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="job-name" className="justify-between">
          Cloud Run job<span className="text-muted-foreground text-xs font-normal">Required</span>
        </Label>
        <Select
          value={jobName || null}
          items={jobOptions.map((name) => ({ value: name, label: name }))}
          onValueChange={(next) => {
            setJobName(next ?? "");
            setAgentName("");
            setValues({});
          }}
        >
          <SelectTrigger id="job-name" className="w-full">
            <SelectValue placeholder={jobOptions.length ? "Choose a job" : "No jobs available"} />
          </SelectTrigger>
          <SelectContent>
            {jobOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">The Cloud Run job that executes this task.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-name" className="justify-between">
          Agent<span className="text-muted-foreground text-xs font-normal">Optional</span>
        </Label>
        <Select
          value={agentName || DEFAULT_AGENT}
          disabled={!jobName}
          items={[
            { value: DEFAULT_AGENT, label: "Default agent" },
            ...jobAgents.map((agent) => ({ value: agent.name, label: agent.name })),
          ]}
          onValueChange={(next) => {
            setAgentName(next === DEFAULT_AGENT ? "" : (next ?? ""));
            setValues({});
          }}
        >
          <SelectTrigger id="agent-name" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_AGENT}>Default agent</SelectItem>
            {jobAgents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name}>
                {agent.name}
                {agent.description ? ` — ${agent.description}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {!jobName
            ? "Choose a job first."
            : registered.isPending
              ? "Loading agents…"
              : jobAgents.length
                ? "Agents registered for this job."
                : "No agents registered for this job, so its default agent runs the task. Use Register agents on the Jobs page."}
        </p>
      </div>
      {selectedAgent && (
        <div className="rounded-lg border p-3">
          <AgentContract agent={selectedAgent} />
        </div>
      )}
      {noInput ? (
        <p className="text-muted-foreground text-xs">
          This agent takes no input. Upload documents to the task after creating it.
        </p>
      ) : fields ? (
        <div className="flex flex-col gap-3">
          <Overline>Input</Overline>
          {fields.map((field) => (
            <SchemaField
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-prompt" className="justify-between">
            Prompt<span className="text-muted-foreground text-xs font-normal">Required</span>
          </Label>
          <Textarea
            id="task-prompt"
            placeholder={
              inputExample(selectedAgent?.inputSchema) ??
              "What would you like your agent to work on?"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            maxLength={10_000}
            rows={8}
            className="min-h-48"
          />
          <div className="text-muted-foreground text-right text-xs">
            {prompt.length.toLocaleString()} / 10,000
          </div>
        </div>
      )}
      {promptProblem && (
        <p className="text-destructive text-xs" role="alert">
          {promptProblem}
        </p>
      )}
      {mutation.isError && <ErrorBox error={mutation.error} />}
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <FileText className="size-4" />
        Creating a task saves it. You choose when to run it.
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!effectivePrompt.trim() || invalid || !jobName || mutation.isPending}
        >
          {mutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          Create task
        </Button>
      </DialogFooter>
    </form>
  );
}
