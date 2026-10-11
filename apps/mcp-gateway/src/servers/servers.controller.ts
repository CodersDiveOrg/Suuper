import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { HostedToolsService, type HostedToolInput } from "../hosted/hosted-tools.service";
import { ToolRunnerService } from "../mcp/tool-runner.service";
import { ServersService, type ServerInput } from "./servers.service";

type Ctx = { businessContext: BusinessContext };

// Business comes from the token, so the path is fixed at "current".
@Controller("businesses/current/mcp-servers")
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly hostedTools: HostedToolsService,
    private readonly runner: ToolRunnerService,
  ) {}

  @Get()
  @RequirePermission("mcp:read")
  list(@Req() req: Ctx) {
    return this.servers.list(req.businessContext.businessId);
  }

  // Declared before ":id" so "calls" isn't captured as a server id.
  @Get("calls")
  @RequirePermission("mcp:read")
  calls(@Req() req: Ctx, @Query() query: { serverId?: string; limit?: string }) {
    return this.servers.listCalls(req.businessContext.businessId, query);
  }

  @Post()
  @RequirePermission("mcp:write")
  create(@Req() req: Ctx, @Body() body: ServerInput) {
    return this.servers.create(req.businessContext.businessId, body ?? {});
  }

  @Get(":id")
  @RequirePermission("mcp:read")
  get(@Req() req: Ctx, @Param("id") id: string) {
    return this.servers.get(req.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("mcp:write")
  update(@Req() req: Ctx, @Param("id") id: string, @Body() body: ServerInput) {
    return this.servers.update(req.businessContext.businessId, id, body ?? {});
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("mcp:write")
  async remove(@Req() req: Ctx, @Param("id") id: string) {
    await this.servers.remove(req.businessContext.businessId, id);
  }

  @Post(":id/refresh")
  @RequirePermission("mcp:write")
  refresh(@Req() req: Ctx, @Param("id") id: string) {
    return this.servers.refresh(req.businessContext.businessId, id);
  }

  /** New access key for outside clients of a hosted server. Shown once; the old key stops working. */
  @Post(":id/access-key")
  @RequirePermission("mcp:write")
  rotateKey(@Req() req: Ctx, @Param("id") id: string) {
    return this.servers.rotateAccessKey(req.businessContext.businessId, id);
  }

  /**
   * Test a tool from the dashboard. Runs the real tool (it may have side
   * effects), so it needs mcp:write; the call is logged with source "test".
   */
  @Post(":id/tools/:toolName/call")
  @RequirePermission("mcp:write")
  async callTool(
    @Req() req: Ctx,
    @Param("id") id: string,
    @Param("toolName") toolName: string,
    @Body() body: { arguments?: unknown },
  ) {
    const { businessId, userId } = req.businessContext;
    await this.servers.require(businessId, id);
    return this.runner.call({ businessId, serverId: id, toolName, args: body?.arguments, source: "test", userId });
  }

  @Post(":id/hosted-tools")
  @RequirePermission("mcp:write")
  createHostedTool(@Req() req: Ctx, @Param("id") id: string, @Body() body: HostedToolInput) {
    return this.hostedTools.create(req.businessContext.businessId, id, body ?? {});
  }

  @Patch(":id/hosted-tools/:toolId")
  @RequirePermission("mcp:write")
  updateHostedTool(@Req() req: Ctx, @Param("id") id: string, @Param("toolId") toolId: string, @Body() body: HostedToolInput) {
    return this.hostedTools.update(req.businessContext.businessId, id, toolId, body ?? {});
  }

  @Delete(":id/hosted-tools/:toolId")
  @HttpCode(204)
  @RequirePermission("mcp:write")
  async deleteHostedTool(@Req() req: Ctx, @Param("id") id: string, @Param("toolId") toolId: string) {
    await this.hostedTools.remove(req.businessContext.businessId, id, toolId);
  }
}
