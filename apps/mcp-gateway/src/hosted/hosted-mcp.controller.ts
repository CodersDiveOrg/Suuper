import { Controller, Delete, Get, Param, Post, Req, Res } from "@nestjs/common";
// Low-level Server on purpose: hosted tools are defined at runtime as JSON
// Schemas, which McpServer.registerTool (zod schemas) doesn't support.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { prisma } from "@platform/database";
import { ToolRunnerService } from "../mcp/tool-runner.service";
import { hashAccessKey } from "../servers/servers.service";

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * A hosted server as a real MCP endpoint (Streamable HTTP, stateless JSON
 * responses), reachable through api-gateway at /mcp/:serverId. Clients
 * authenticate with `Authorization: Bearer <access key>`.
 */
@Controller("mcp")
export class HostedMcpController {
  constructor(private readonly runner: ToolRunnerService) {}

  @Post(":serverId")
  async handle(@Param("serverId") serverId: string, @Req() req: Request, @Res() res: Response) {
    const header = req.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const server = key ? await prisma.mcpServer.findUnique({ where: { accessKeyHash: hashAccessKey(key) } }) : null;
    // Same response for a wrong key and a wrong server id — don't reveal which servers exist.
    if (!server || server.id !== serverId || server.mode !== "hosted") {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
      return jsonRpcError(res, 401, "Invalid or missing access key");
    }
    if (!server.enabled) return jsonRpcError(res, 403, "This MCP server is disabled");

    const mcp = new Server(
      { name: server.name, version: "1.0.0" },
      { capabilities: { tools: {} }, ...(server.description ? { instructions: server.description } : {}) },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await this.runner.toolsFor(server)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object" },
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await this.runner.call({
          businessId: server.businessId,
          serverId: server.id,
          toolName: request.params.name,
          args: request.params.arguments ?? {},
          source: "mcp_client",
        });
        return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // Stateless server: no standalone SSE stream and no sessions to delete.
  @Get(":serverId")
  get(@Res() res: Response) {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, "Method not allowed");
  }

  @Delete(":serverId")
  remove(@Res() res: Response) {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, "Method not allowed");
  }
}
