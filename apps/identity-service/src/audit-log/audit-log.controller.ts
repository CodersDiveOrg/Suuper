import { Controller, Get, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { AuditLogService, type AuditFilters } from "./audit-log.service";

type Ctx = { businessContext: BusinessContext };

// Events are written by @platform/database's audit middleware in every service; reading lives here.
@Controller("businesses/current/audit-log")
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @RequirePermission("audit:read")
  list(@Req() req: Ctx, @Query() query: AuditFilters) {
    return this.auditLog.list(req.businessContext.businessId, query);
  }

  @Get("facets")
  @RequirePermission("audit:read")
  facets(@Req() req: Ctx) {
    return this.auditLog.facets(req.businessContext.businessId);
  }

  @Get("export")
  @RequirePermission("audit:read")
  export(@Req() req: Ctx, @Query() query: AuditFilters) {
    return this.auditLog.export(req.businessContext.businessId, query);
  }
}
