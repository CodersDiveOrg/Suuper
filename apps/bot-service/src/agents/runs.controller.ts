import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { RunsService } from "./runs.service";

// A separate base path so "runs" never collides with an agent id route.
@Controller("businesses/current/agent-runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  @RequirePermission("agents:read")
  async list(
    @Req() req: { businessContext: BusinessContext },
    @Query() query: { agentId?: string; status?: string; trigger?: string; scheduleId?: string; limit?: string; before?: string },
  ) {
    return this.runs.list(req.businessContext, query);
  }

  // Declared before ":runId" so it isn't captured as a run id.
  @Get("analytics")
  @RequirePermission("agents:read")
  async analytics(@Req() req: { businessContext: BusinessContext }, @Query() query: { days?: string; timezone?: string }) {
    return this.runs.analytics(req.businessContext, query);
  }

  @Get(":runId")
  @RequirePermission("agents:read")
  async get(@Req() req: { businessContext: BusinessContext }, @Param("runId") runId: string) {
    return this.runs.get(req.businessContext, runId);
  }
}
