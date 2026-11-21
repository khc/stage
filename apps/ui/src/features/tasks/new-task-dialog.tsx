import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Layers3, Plus } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { AgentContract } from "@/features/jobs/agents";
import { ModelPicker } from "@/features/models/model-picker";
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
  type ModelRef,
} from "@/lib/api";
import { modelOptions } from "@/lib/models";
import { useNav } from "@/lib/nav";
import { useJobs, useProviders } from "@/lib/queries";

import { SchemaField } from "./schema-field";

const DEFAULT_AGENT = "__default";

// The body of the create request: trimmed, with the agent and the default model only when given.
export const taskInput = (form: {
  name: string;
  prompt: string;
  jobName: string;
  agentName: string;
  model?: ModelRef;
}) => ({
  name: form.name.trim(),
  prompt: form.prompt.trim(),
  jobName: form.jobName,
  ...(form.agentName.trim() && { agentName: form.agentName.trim() }),
  ...(form.model && { defaultModel: form.model }),
});

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

export function NewTaskForm({
  jobs,
  initialJob,
  onClose,
}: {
  jobs: Job[];
  initialJob: string;
  onClose: () => void;
}) {
  const { openTask } = useNav();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [jobName, setJobName] = useState(initialJob);
  const [agentName, setAgentName] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const [model, setModel] = useState<ModelRef | undefined>();
  const models = modelOptions(useProviders().data?.providers ?? []);
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
  // Why Create task is disabled, shown next to it rather than in a tooltip.
  const submitHint = !name.trim()
    ? "Enter a task name first."
    : !jobName
      ? "Choose a job first."
      : !effectivePrompt.trim()
        ? "Write a prompt first."
        : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(taskInput({ name, prompt: effectivePrompt, jobName, agentName, model }));
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <span className="mb-1 grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
          <Layers3 className="size-5" />
        </span>
        <DialogTitle>Create a task</DialogTitle>
        <DialogDescription>A name, a prompt, and a worker.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-name" className="justify-between">
          Task name<span className="text-xs font-normal text-muted-foreground">Required</span>
        </Label>
        <Input
          id="task-name"
          placeholder="Short title for this task"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="job-name" className="justify-between">
          Cloud Run job<span className="text-xs font-normal text-muted-foreground">Required</span>
        </Label>
        <Select
          value={jobName || null}
          items={jobOptions.map((job) => ({ value: job, label: job }))}
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
            {jobOptions.map((job) => (
              <SelectItem key={job} value={job}>
                {job}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">The Cloud Run job that executes this task.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-name" className="justify-between">
          Agent<span className="text-xs font-normal text-muted-foreground">Optional</span>
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
        <p className="text-xs text-muted-foreground">
          {!jobName
            ? "Choose a job first."
            : registered.isPending
              ? "Loading agents…"
              : jobAgents.length
                ? "Agents registered for this job."
                : "No agents registered for this job, so its default agent runs the task. Use Register agents on the Jobs page."}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-model" className="justify-between">
          Default model<span className="text-xs font-normal text-muted-foreground">Optional</span>
        </Label>
        <ModelPicker id="task-model" options={models} value={model} onChange={setModel} />
        <p className="text-xs text-muted-foreground">
          {models.length
            ? "The model the chat starts on; you can change it for any message. Job default uses the job's own model."
            : "No models are switched on yet. Add some in Settings → Providers, or leave the job's own model."}
        </p>
      </div>
      {selectedAgent && (
        <div className="rounded-lg border p-3">
          <AgentContract agent={selectedAgent} />
        </div>
      )}
      {noInput ? (
        <p className="text-xs text-muted-foreground">
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
            Prompt<span className="text-xs font-normal text-muted-foreground">Required</span>
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
          <div className="text-right text-xs text-muted-foreground">
            {prompt.length.toLocaleString()} / 10,000
          </div>
        </div>
      )}
      {promptProblem && (
        <p className="text-xs text-destructive" role="alert">
          {promptProblem}
        </p>
      )}
      {mutation.isError && <ErrorBox error={mutation.error} />}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="size-4" />
        Creating a task saves it. You choose when to run it.
      </p>
      {submitHint && (
        <p id="submit-hint" className="text-right text-xs text-muted-foreground">
          {submitHint}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          aria-describedby={submitHint ? "submit-hint" : undefined}
          disabled={
            !name.trim() || !effectivePrompt.trim() || invalid || !jobName || mutation.isPending
          }
        >
          {mutation.isPending ? <Spinner /> : <Plus />}
          Create task
        </Button>
      </DialogFooter>
    </form>
  );
}
