import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { SkillsService, type SkillInput } from "./skills.service";

// Own base path so "skills" never collides with an agent id route.
@Controller("businesses/current/agent-skills")
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequirePermission("agents:read")
  list(@Req() req: { businessContext: BusinessContext }) {
    return this.skills.list(req.businessContext.businessId);
  }

  @Post()
  @RequirePermission("agents:write")
  create(@Req() req: { businessContext: BusinessContext }, @Body() body: SkillInput) {
    return this.skills.create(req.businessContext.businessId, body ?? {});
  }

  @Patch(":id")
  @RequirePermission("agents:write")
  update(@Req() req: { businessContext: BusinessContext }, @Param("id") id: string, @Body() body: SkillInput) {
    return this.skills.update(req.businessContext.businessId, id, body ?? {});
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("agents:write")
  async remove(@Req() req: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.skills.remove(req.businessContext.businessId, id);
  }
}
