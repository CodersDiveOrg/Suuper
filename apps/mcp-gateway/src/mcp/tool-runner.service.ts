import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { prisma, Prisma } from "@platform/database";
import { hostedParamsToSchema, type HostedToolParam, type McpCallResult, type McpToolInfo } from "@platform/shared-types";
import { callExternalTool } from "./external-client";
import { executeHostedTool } from "./hosted-executor";

export type CallSource = "test" | "agent" | "bot" | "mcp_client";

/** Flattens MCP content blocks into text a model (or a person) can read. */
export function resultToText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "image":
        return `[image ${block.mimeType}]`;
      case "audio":
        return `[audio ${block.mimeType}]`;
      case "resource_link":
        return `[resource ${block.uri}]`;
      case "resource":
        return "text" in block.resource ? String(block.resource.text) : `[resource ${block.resource.uri}]`;
      default:
        return "";
    }
  });
  if (parts.every((p) => !p) && result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
  return parts.filter(Boolean).join("\n");
}

@Injectable()
export class ToolRunnerService {
  /** Tools a server offers: hosted → from its definitions; external → last discovered list. */
  async toolsFor(server: { id: string; mode: string; tools: unknown }): Promise<McpToolInfo[]> {
    if (server.mode === "hosted") {
      const hosted = await prisma.mcpHostedTool.findMany({ where: { serverId: server.id }, orderBy: { name: "asc" } });
      return hosted.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: hostedParamsToSchema(t.parameters as unknown as HostedToolParam[]),
      }));
    }
    return (server.tools as McpToolInfo[]) ?? [];
  }

  /** Calls one tool and records it in McpToolCall. Tool failures are results, not exceptions. */
  async call(params: {
    businessId: string;
    serverId: string;
    toolName: string;
    args: unknown;
    source: CallSource;
    userId?: string;
  }): Promise<McpCallResult> {
    const { businessId, serverId, toolName, source, userId } = params;
    if (params.args !== undefined && (typeof params.args !== "object" || params.args === null || Array.isArray(params.args))) {
      throw new BadRequestException("arguments must be an object");
    }
    const args = (params.args ?? {}) as Record<string, unknown>;

    const server = await prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!server || server.businessId !== businessId) throw new NotFoundException("MCP server not found");
    if (!server.enabled) throw new BadRequestException("This MCP server is disabled");

    const started = Date.now();
    let result: McpCallResult;
    try {
      if (server.mode === "hosted") {
        const tool = await prisma.mcpHostedTool.findUnique({ where: { serverId_name: { serverId, name: toolName } } });
        if (!tool) throw new NotFoundException(`Tool not found: ${toolName}`);
        const out = await executeHostedTool(tool, args);
        result = { ...out, durationMs: Date.now() - started };
      } else {
        const raw = await callExternalTool(server, toolName, args);
        result = { content: resultToText(raw), isError: !!raw.isError, durationMs: Date.now() - started, raw };
      }
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      result = { content: (err as Error).message || "Tool call failed", isError: true, durationMs: Date.now() - started };
    }

    await prisma.mcpToolCall.create({
      data: {
        businessId,
        serverId,
        toolName,
        source,
        userId,
        input: args as Prisma.InputJsonValue,
        output: { content: result.content.slice(0, 20_000) },
        isError: result.isError,
        durationMs: result.durationMs,
      },
    });
    return result;
  }
}
