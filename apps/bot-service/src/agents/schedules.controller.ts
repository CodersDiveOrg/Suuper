import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { SchedulesService, type ScheduleInput } from "./schedules.service";

@Controller("businesses/current/agent-schedules")
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @RequirePermission("agents:read")
  list(@Req() req: { businessContext: BusinessContext }, @Query("agentId") agentId?: string) {
    return this.schedules.list(req.businessContext.businessId, agentId);
  }

  @Post()
  @RequirePermission("agents:write")
  create(@Req() req: { businessContext: BusinessContext }, @Body() body: ScheduleInput) {
    const { businessId, userId } = req.businessContext;
    return this.schedules.create(businessId, userId, body ?? {});
  }

  @Patch(":id")
  @RequirePermission("agents:write")
  update(@Req() req: { businessContext: BusinessContext }, @Param("id") id: string, @Body() body: ScheduleInput) {
    return this.schedules.update(req.businessContext.businessId, id, body ?? {});
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("agents:write")
  async remove(@Req() req: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.schedules.remove(req.businessContext.businessId, id);
  }

  @Post(":id/run")
  @HttpCode(202)
  @RequirePermission("agents:run")
  runNow(@Req() req: { businessContext: BusinessContext }, @Param("id") id: string) {
    const { businessId, userId } = req.businessContext;
    return this.schedules.runNow(businessId, id, userId);
  }
}
