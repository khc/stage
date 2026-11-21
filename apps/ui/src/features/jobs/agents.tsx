import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, schemaRows, schemaSummary, type AgentInfo, type JsonSchema } from "@/lib/api";

const REGISTRATION_POLL_MS = 30_000;

// Registration is asynchronous, so poll the registry for a while after submitting. The deadline
// lives in the query cache, so every view of the same job (a table cell and its action cell) polls.
export function useAgentRegistration(jobName: string, enabled = true) {
  const client = useQueryClient();
  const pollKey = ["agents-poll", jobName];
  // A refetch (the shell refresh, an event-stream reconnect) must keep the deadline, not reset it.
  const poll = useQuery({
    queryKey: pollKey,
    queryFn: () => client.getQueryData<number>(pollKey) ?? 0,
    initialData: 0,
    staleTime: Infinity,
  });
  const query = useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName),
    enabled,
    retry: false,
    refetchInterval: () => (Date.now() < poll.data ? 3000 : false),
  });
  const register = useMutation({
    mutationFn: () => api.registerAgents(jobName),
    onSuccess: () => client.setQueryData(pollKey, Date.now() + REGISTRATION_POLL_MS),
  });
  return { agents: query.data?.agents ?? [], query, register };
}

type Register = ReturnType<typeof useAgentRegistration>["register"];

export function RegisterAgentsButton({
  register,
  disabled,
  className,
  variant = "outline",
}: {
  register: Register;
  disabled?: boolean;
  className?: string;
  variant?: "outline" | "ghost";
}) {
  return (
    <Button
      variant={variant}
      className={className}
      disabled={disabled || register.isPending}
      onClick={() => register.mutate()}
    >
      {register.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Register agents
    </Button>
  );
}

export function RegisterAgentsNote({ register }: { register: Register }) {
  if (register.isError)
    return (
      <p className="text-xs text-destructive" role="alert">
        {register.error.message}
      </p>
    );
  if (register.isSuccess)
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Registration submitted. Agents appear here when the job finishes.
      </p>
    );
  return null;
}

export function AgentContract({ agent }: { agent: AgentInfo }) {
  const rows: [string, JsonSchema | undefined][] = [
    ["Input", agent.inputSchema],
    ["Output", agent.outputSchema],
  ];
  return (
    <dl className="flex flex-col gap-2 text-sm">
      {rows.map(([label, schema]) => {
        const fields = schemaRows(schema);
        return (
          <div key={label}>
            <dt className="text-xs font-semibold text-muted-foreground uppercase">{label}</dt>
            <dd>
              {fields.length ? (
                <ul className="flex flex-col gap-1">
                  {fields.map((row) => (
                    <li key={row.name}>
                      <code className="font-mono text-xs">{row.name}</code>{" "}
                      <span className="text-muted-foreground">{row.type}</span>
                      {row.required && (
                        <em className="ml-1 text-xs text-muted-foreground">required</em>
                      )}
                      {row.description && (
                        <p className="text-xs text-muted-foreground">{row.description}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  {schemaSummary(schema)}
                  {schema?.description && ` — ${schema.description}`}
                </>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
