import axios from "axios";
import { signBusinessToken } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import type { McpCallResult, McpToolInfo } from "@platform/shared-types";
import type { ClientTool } from "./providers/types";
import type { ToolResult } from "./tools";

const config = loadServiceConfig("bot-service", 3002);

export interface McpToolRef {
  serverId: string;
  toolName: string;
}

function internalAuth(businessId: string) {
  // Short-lived internal token for mcp-gateway's service-to-service API.
  const token = signBusinessToken({ userId: "agent-runtime", businessId, role: "member", permissions: ["mcp:read"] });
  return { Authorization: `Bearer ${token}` };
}

// Model-facing tool names must match ^[a-zA-Z0-9_-]{1,64}$ and be unique across servers.
function modelToolName(serverName: string, toolName: string, taken: Set<string>) {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = `${clean(serverName).slice(0, 20) || "mcp"}__${clean(toolName)}`.slice(0, 60);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 58)}_${i}`;
  taken.add(name);
  return name;
}

/**
 * Tool definitions for the given MCP servers, plus a map from each model-facing
 * name back to (server, tool). A server that can't be reached is skipped rather
 * than failing the whole run.
 */
export async function loadMcpTools(businessId: string, serverIds: string[], reservedNames: string[] = []) {
  const definitions: ClientTool[] = [];
  const refs = new Map<string, McpToolRef>();
  if (serverIds.length === 0) return { definitions, refs };

  const response = await axios
    .post<{ serverId: string; serverName: string; tools: McpToolInfo[] }[]>(
      `${config.mcpGatewayUrl}/internal/mcp/tools`,
      { serverIds },
      { headers: internalAuth(businessId), timeout: 15_000 },
    )
    .catch(() => null);

  const taken = new Set(reservedNames);
  for (const server of response?.data ?? []) {
    for (const tool of server.tools) {
      const name = modelToolName(server.serverName, tool.name, taken);
      refs.set(name, { serverId: server.serverId, toolName: tool.name });
      definitions.push({
        name,
        description: `[${server.serverName}] ${tool.description ?? tool.name}`.slice(0, 1024),
        input_schema: { type: "object", ...(tool.inputSchema ?? {}) } as ClientTool["input_schema"],
      });
    }
  }
  return { definitions, refs };
}

export async function callMcpTool(
  businessId: string,
  ref: McpToolRef,
  args: unknown,
  meta: { source: "agent" | "bot"; userId?: string },
): Promise<ToolResult> {
  try {
    const { data } = await axios.post<McpCallResult>(
      `${config.mcpGatewayUrl}/internal/mcp/call`,
      { serverId: ref.serverId, toolName: ref.toolName, arguments: args ?? {}, ...meta },
      { headers: internalAuth(businessId), timeout: 90_000 },
    );
    return { content: data.content || "(empty result)", isError: data.isError };
  } catch (err) {
    const message = axios.isAxiosError(err) ? ((err.response?.data as { message?: string })?.message ?? err.message) : (err as Error).message;
    return { content: `MCP tool call failed: ${message}`, isError: true };
  }
}
