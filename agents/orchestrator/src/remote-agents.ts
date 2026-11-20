import {
  BaseToolset,
  FunctionTool,
  InMemoryRunner,
  isFinalResponse,
  stringifyContent,
  type BaseTool,
  type ReadonlyContext,
} from "@google/adk";
import { RemoteA2AAgent, type RemoteA2AAgentConfig } from "@google/adk/a2a";
import type { AgentRegistry, JsonSchema } from "@stage/agents/agent-registry";
import { agentNameSchema } from "@stage/agents/spec";
import { z } from "zod";

const jobNamePattern = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

// The registry is data written by jobs: only names that fit an endpoint path and an ADK tool name are used.
const isEndpointName = (jobName: string, name: string) =>
  jobName.length <= 63 && jobNamePattern.test(jobName) && agentNameSchema.safeParse(name).success;

// How an agent is called with text: free text as is, a JSON object as JSON text the model must write
// itself. An agent with no input at all reads the task's documents, which a delegated task has none.
const inputHint = (schema: JsonSchema | undefined) => {
  if (!schema || schema.type === "string") return "";
  return `\nSend the request as JSON text matching this JSON Schema: ${JSON.stringify(schema)}`;
};
const takesNoInput = (schema: JsonSchema | undefined) =>
  schema?.type === "object" &&
  Object.keys((schema.properties as object | undefined) ?? {}).length === 0;

export type RemoteAgentsDeps = {
  // Built on first use, so importing the agent never touches Firestore.
  registry: () => Pick<AgentRegistry, "listAll">;
  env: Record<string, string | undefined>;
  // How a remote agent is built; tests replace it to see the configuration.
  remoteAgent?: (config: RemoteA2AAgentConfig) => RemoteA2AAgent;
};

// Calls a remote agent with a request and returns its final reply. ADK's AgentTool is not used: it runs
// the agent through the caller's session service under the caller's session id, which on the platform is
// the Firestore service holding the orchestrator's own session, so the remote run would break its lease.
// The remote agent runs in a session of its own, in memory.
const callRemote = async (agent: RemoteA2AAgent, request: string) => {
  const runner = new InMemoryRunner({ agent, appName: agent.name });
  const userId = "orchestrator";
  const session = await runner.sessionService.createSession({ appName: agent.name, userId });
  let reply = "";
  let failure: string | undefined;
  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: request }] },
  })) {
    // A failed remote task arrives as a final event with an error message and no content.
    if (event.errorMessage) failure = event.errorMessage;
    if (isFinalResponse(event) && event.content?.parts?.length)
      reply = stringifyContent(event).trim();
  }
  // Thrown, so the model is told the agent failed instead of receiving an empty answer.
  if (failure) throw new Error(failure);
  if (!reply) throw new Error("The agent returned no reply");
  return reply;
};

// The other registered agents as tools, discovered from the registry when a run asks for its tools
// and reached over A2A at the platform's gateway. Each is a function tool, so the orchestrator can call
// several and combine their replies. The orchestrator's own job is left out.
export class RemoteAgentsToolset extends BaseToolset {
  private cached?: { invocationId: string | undefined; tools: Promise<BaseTool[]> };

  constructor(private readonly deps: RemoteAgentsDeps) {
    super();
  }

  // ADK asks for the tools on every model request; the registry is read once per invocation.
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const invocationId = context?.invocationId;
    if (this.cached && this.cached.invocationId === invocationId) return this.cached.tools;
    const tools = this.load();
    this.cached = { invocationId, tools };
    tools.catch(() => {
      if (this.cached?.tools === tools) this.cached = undefined;
    });
    return tools;
  }

  // The tools hold no connections: each call opens its own request to the gateway.
  async close(): Promise<void> {}

  private async load(): Promise<BaseTool[]> {
    const { registry, env, remoteAgent = (config) => new RemoteA2AAgent(config) } = this.deps;
    const gatewayUrl = env.GATEWAY_URL?.replace(/\/+$/, "");
    if (!gatewayUrl) throw new Error("GATEWAY_URL is required to reach the other agents");
    // ADK refuses an agent card on plaintext http unless the host is loopback; only a local run opts in.
    const resolveAgentCardOptions =
      env.GATEWAY_ALLOW_INSECURE === "true" ? { allowInsecureRpc: true } : undefined;
    const agents = await registry().listAll();
    return agents
      .filter(
        ({ jobName, name, inputSchema }) =>
          jobName !== env.JOB_NAME && isEndpointName(jobName, name) && !takesNoInput(inputSchema),
      )
      .map(({ jobName, name, description, inputSchema }) => {
        const agent = remoteAgent({
          name: `${jobName}__${name}`,
          description: `${description ?? `The ${name} agent of ${jobName}`}${inputHint(inputSchema)}`,
          // The trailing slash matters: the SDK resolves `.well-known/agent-card.json` relative to this URL.
          agentCard: `${gatewayUrl}/a2a/${jobName}/${name}/`,
          messageSendConfig: { blocking: true },
          ...(resolveAgentCardOptions && { resolveAgentCardOptions }),
        });
        return new FunctionTool({
          name: agent.name,
          description: agent.description,
          parameters: z.object({
            request: z.string().describe("The request to send to this agent."),
          }),
          execute: ({ request }) => callRemote(agent, request),
        });
      });
  }
}
