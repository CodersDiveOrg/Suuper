import type { ProviderName } from "./models";
import { callMcpTool, loadMcpTools } from "./mcp-tools";
import { loadIntegrationTools } from "./integrations";
import type { ClientTool } from "./providers/types";
import { executeTool, toolsFor, type ToolContext, type ToolResult } from "./tools";

export interface ToolSet {
  clientTools: ClientTool[];
  serverTools: string[];
  execute(name: string, input: unknown): Promise<ToolResult>;
}

/** Built-in tools + attached integrations' actions + MCP tools, behind one execute(). */
export async function buildToolSet(params: {
  businessId: string;
  provider: ProviderName;
  builtInTools: string[];
  knowledgeBaseIds: string[];
  mcpServerIds: string[];
  integrations?: string[];
  source: "agent" | "bot";
  userId?: string;
}): Promise<ToolSet> {
  const { clientTools, serverTools } = toolsFor(params.builtInTools, params.provider);
  const ctx: ToolContext = { businessId: params.businessId, knowledgeBaseIds: params.knowledgeBaseIds, counters: {} };
  const integrations = await loadIntegrationTools(params.businessId, params.integrations ?? [], ctx.counters);
  const mcp = await loadMcpTools(
    params.businessId,
    params.mcpServerIds,
    [...clientTools.map((t) => t.name), ...serverTools, ...integrations.definitions.map((t) => t.name)],
  );

  return {
    clientTools: [...clientTools, ...integrations.definitions, ...mcp.definitions],
    serverTools,
    execute: async (name, input) => {
      const ref = mcp.refs.get(name);
      if (ref) return callMcpTool(params.businessId, ref, input, { source: params.source, userId: params.userId });
      const integrationResult = await integrations.execute(name, input);
      if (integrationResult) return integrationResult;
      return executeTool(ctx, params.builtInTools, name, input);
    },
  };
}
