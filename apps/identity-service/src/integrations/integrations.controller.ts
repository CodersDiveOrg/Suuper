import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { IntegrationsService } from "./integrations.service";

interface ConnectBody {
  values?: unknown;
  enabled?: unknown;
}

// Business comes from the token, so the path is fixed at "current".
@Controller("businesses/current/integrations")
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  @RequirePermission("integrations:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.integrationsService.list(request.businessContext.businessId);
  }

  /** Connect, or update an existing connection's fields. */
  @Put(":provider")
  @RequirePermission("integrations:write")
  async connect(
    @Req() request: { businessContext: BusinessContext },
    @Param("provider") provider: string,
    @Body() body: ConnectBody,
  ) {
    const { businessId, userId } = request.businessContext;
    return this.integrationsService.connect(businessId, userId, provider, body);
  }

  @Patch(":provider")
  @RequirePermission("integrations:write")
  async setEnabled(
    @Req() request: { businessContext: BusinessContext },
    @Param("provider") provider: string,
    @Body() body: { enabled?: unknown },
  ) {
    return this.integrationsService.setEnabled(request.businessContext.businessId, provider, body.enabled);
  }

  @Delete(":provider")
  @HttpCode(204)
  @RequirePermission("integrations:write")
  async disconnect(@Req() request: { businessContext: BusinessContext }, @Param("provider") provider: string) {
    await this.integrationsService.disconnect(request.businessContext.businessId, provider);
  }
}
