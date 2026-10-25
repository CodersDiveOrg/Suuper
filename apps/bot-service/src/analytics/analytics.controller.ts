import { Controller, Get, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { AnalyticsService } from "./analytics.service";

@Controller("businesses/current/analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // Every role can open it; sections the caller can't read are left out.
  @Get("overview")
  @RequirePermission("business:read")
  overview(@Req() req: { businessContext: BusinessContext }, @Query() query: { days?: string; timezone?: string }) {
    return this.analytics.overview(req.businessContext, query);
  }
}
