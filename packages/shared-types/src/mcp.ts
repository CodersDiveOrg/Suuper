// MCP servers (mcp-gateway). A tool as discovered from a server's tools/list.
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpServerMode = "hosted" | "external";
export type McpServerStatus = "pending" | "connected" | "error";
export type McpTransport = "auto" | "streamable_http" | "sse";
export type McpAuthType = "none" | "bearer" | "header";

export type HostedToolParamType = "string" | "number" | "integer" | "boolean";

export interface HostedToolParam {
  name: string;
  type: HostedToolParamType;
  description?: string;
  required: boolean;
  enum?: string[];
}

export const HOSTED_TOOL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HostedToolMethod = (typeof HOSTED_TOOL_METHODS)[number];

/** Result of calling an MCP tool, normalised to text for models and UIs. */
export interface McpCallResult {
  content: string;
  isError: boolean;
  durationMs: number;
  /** The raw MCP CallToolResult (content blocks, structuredContent). */
  raw?: unknown;
}

/** Turns a hosted tool's parameter list into the JSON Schema MCP advertises. */
export function hostedParamsToSchema(params: HostedToolParam[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      params.map((p) => [
        p.name,
        { type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.enum?.length ? { enum: p.enum } : {}) },
      ]),
    ),
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}
