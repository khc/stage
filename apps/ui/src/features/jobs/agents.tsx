import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api, schemaRows, schemaSummary, type AgentInfo, type JsonSchema } from "@/lib/api";

const REGISTRATION_POLL_MS = 30_000;

// Registration is asynchronous, so poll the registry for a while after submitting.
export function useAgentRegistration(jobName: string, enabled = true) {
  const [pollUntil, setPollUntil] = useState(0);
  const query = useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName),
    enabled,
    retry: false,
    refetchInterval: () => (Date.now() < pollUntil ? 3000 : false),
  });
  const register = useMutation({
    mutationFn: () => api.registerAgents(jobName),
    onSuccess: () => setPollUntil(Date.now() + REGISTRATION_POLL_MS),
  });
  return { agents: query.data?.agents ?? [], query, register };
}

export function RegisterAgentsButton({
  register,
  disabled,
}: {
  register: ReturnType<typeof useAgentRegistration>["register"];
  disabled?: boolean;
}) {
  return (
    <>
      <Button
        variant="outline"
        className="w-full"
        disabled={disabled || register.isPending}
        onClick={() => register.mutate()}
      >
        {register.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Register agents
      </Button>
      {register.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {register.error.message}
        </p>
      ) : register.isSuccess ? (
        <p className="text-muted-foreground text-xs" role="status">
          Registration submitted. Agents appear here when the job finishes.
        </p>
      ) : null}
    </>
  );
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
            <dt className="text-muted-foreground text-xs font-semibold uppercase">{label}</dt>
            <dd>
              {fields.length ? (
                <ul className="flex flex-col gap-1">
                  {fields.map((row) => (
                    <li key={row.name}>
                      <code className="font-mono text-xs">{row.name}</code>{" "}
                      <span className="text-muted-foreground">{row.type}</span>
                      {row.required && (
                        <em className="text-muted-foreground ml-1 text-xs">required</em>
                      )}
                      {row.description && (
                        <p className="text-muted-foreground text-xs">{row.description}</p>
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
