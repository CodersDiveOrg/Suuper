import { BadRequestException, Body, Controller, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { prisma } from "@platform/database";
import { ToolRunnerService, type CallSource } from "../mcp/tool-runner.service";

/**
 * Service-to-service API for bot-service (agent and bot tool loops). Not
 * routed by api-gateway, so it's only reachable inside the platform network;
 * callers send a short-lived internal business token.
 */
@Controller("internal/mcp")
export class InternalController {
  constructor(private readonly runner: ToolRunnerService) {}

  /** Tools of the given servers (enabled, same business). Unknown ids are skipped. */
  @Post("tools")
  @RequirePermission("mcp:read")
  async tools(@Req() req: { businessContext: BusinessContext }, @Body() body: { serverIds?: unknown }) {
    const ids = Array.isArray(body?.serverIds) ? body.serverIds.filter((v): v is string => typeof v === "string") : [];
    if (ids.length === 0) return [];
    const servers = await prisma.mcpServer.findMany({
      where: { id: { in: ids }, businessId: req.businessContext.businessId, enabled: true },
    });
    return Promise.all(
      servers.map(async (s) => ({ serverId: s.id, serverName: s.name, tools: await this.runner.toolsFor(s) })),
    );
  }

  @Post("call")
  @RequirePermission("mcp:read")
  async call(
    @Req() req: { businessContext: BusinessContext },
    @Body() body: { serverId?: unknown; toolName?: unknown; arguments?: unknown; source?: unknown; userId?: unknown },
  ) {
    if (typeof body?.serverId !== "string" || typeof body.toolName !== "string") {
      throw new BadRequestException("serverId and toolName are required");
    }
    const source: CallSource = body.source === "bot" ? "bot" : "agent";
    return this.runner.call({
      businessId: req.businessContext.businessId,
      serverId: body.serverId,
      toolName: body.toolName,
      args: body.arguments,
      source,
      userId: typeof body.userId === "string" ? body.userId : undefined,
    });
  }
}
