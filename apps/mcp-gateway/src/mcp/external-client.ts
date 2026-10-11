import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertPublicUrl, decryptJson } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import type { McpToolInfo, McpTransport } from "@platform/shared-types";

const config = loadServiceConfig("mcp-gateway", 3003);

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

export interface ExternalServer {
  endpointUrl: string | null;
  transport: string;
  authType: string;
  authHeaderName: string | null;
  secretsEncrypted: string | null;
}

function authHeaders(server: ExternalServer): Record<string, string> {
  if (server.authType === "none" || !server.secretsEncrypted) return {};
  const { secret } = decryptJson<{ secret: string }>(server.secretsEncrypted);
  if (server.authType === "bearer") return { Authorization: `Bearer ${secret}` };
  if (server.authType === "header" && server.authHeaderName) return { [server.authHeaderName]: secret };
  return {};
}

/**
 * Opens a short-lived MCP client session, runs `fn`, and closes it. "auto"
 * tries Streamable HTTP (current spec) and falls back to the legacy HTTP+SSE
 * transport. Returns which transport worked so callers can remember it.
 */
async function withClient<T>(server: ExternalServer, fn: (client: Client) => Promise<T>): Promise<{ result: T; transport: McpTransport }> {
  if (!server.endpointUrl) throw new Error("This server has no URL");
  const url = await assertPublicUrl(server.endpointUrl, { allowPrivate: config.mcpAllowPrivateUrls });
  const headers = authHeaders(server);

  const attempt = async (kind: "streamable_http" | "sse") => {
    const client = new Client({ name: "ai-automation-platform", version: "1.0.0" });
    const transport =
      kind === "sse"
        ? new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  if (server.transport === "sse") return { result: await attempt("sse"), transport: "sse" };
  if (server.transport === "streamable_http") return { result: await attempt("streamable_http"), transport: "streamable_http" };
  try {
    return { result: await attempt("streamable_http"), transport: "streamable_http" };
  } catch (streamableError) {
    try {
      return { result: await attempt("sse"), transport: "sse" };
    } catch {
      throw streamableError;
    }
  }
}

/** Connects and lists every tool (following pagination). */
export async function discoverTools(server: ExternalServer) {
  const { result, transport } = await withClient(server, async (client) => {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
      for (const t of page.tools) {
        tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  });
  return { tools: result, transport };
}

export async function callExternalTool(server: ExternalServer, name: string, args: Record<string, unknown>) {
  const { result } = await withClient(server, (client) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }),
  );
  return result as CallToolResult;
}
