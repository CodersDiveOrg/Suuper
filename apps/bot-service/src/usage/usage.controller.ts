import { Body, Controller, Get, Patch, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { UsageService } from "./usage.service";

type Ctx = { businessContext: BusinessContext };

@Controller("businesses/current/usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequirePermission("business:read")
  summary(@Req() req: Ctx, @Query("month") month?: string) {
    return this.usage.summary(req.businessContext.businessId, month);
  }

  @Get("plans")
  @RequirePermission("business:read")
  plans() {
    return this.usage.plans();
  }

  @Patch("plan")
  @RequirePermission("business:manage")
  setPlan(@Req() req: Ctx, @Body() body: { plan?: unknown }) {
    return this.usage.setPlan(req.businessContext.businessId, body?.plan);
  }
}
