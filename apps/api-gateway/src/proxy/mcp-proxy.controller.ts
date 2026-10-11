import { All, Controller, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo, streamTo } from "./forward";

const mcpGatewayUrl = loadServiceConfig("api-gateway", 3010).mcpGatewayUrl;

// Dashboard API for managing MCP servers. More specific than
// BusinessesProxyController's "businesses/*", so registered before it.
@Controller("businesses/current/mcp-servers")
export class McpServersProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(mcpGatewayUrl, req);
  }
}

// Hosted MCP servers as real MCP endpoints for outside clients (Claude
// Desktop, Cursor…). Piped, not buffered: MCP may answer with an SSE stream.
@Controller("mcp")
export class HostedMcpProxyController {
  @All("*")
  handle(@Req() req: Request, @Res() res: Response) {
    return streamTo(mcpGatewayUrl, req, res);
  }
}
