import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from "@nestjs/common";
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

  /** "Connect with …" step 1 → { url } of the provider's consent screen. Body: { values?: pre-fields } */
  @Post(":provider/oauth/start")
  @RequirePermission("integrations:write")
  startOAuth(
    @Req() request: { businessContext: BusinessContext },
    @Param("provider") provider: string,
    @Body() body: { values?: unknown },
  ) {
    const { businessId, userId } = request.businessContext;
    return this.integrationsService.startOAuth(businessId, userId, provider, body);
  }

  /** Step 2, called by the web app's /oauth/callback page with the provider's code + state. */
  @Post("oauth/complete")
  @HttpCode(200)
  @RequirePermission("integrations:write")
  completeOAuth(@Req() request: { businessContext: BusinessContext }, @Body() body: { code?: unknown; state?: unknown }) {
    const { businessId, userId } = request.businessContext;
    return this.integrationsService.completeOAuth(businessId, userId, body ?? {});
  }

  /** WhatsApp Embedded Signup finished in the browser. Body: { code, wabaId, phoneNumberId } */
  @Post("whatsapp/signup")
  @HttpCode(200)
  @RequirePermission("integrations:write")
  completeWhatsAppSignup(
    @Req() request: { businessContext: BusinessContext },
    @Body() body: { code?: unknown; wabaId?: unknown; phoneNumberId?: unknown },
  ) {
    const { businessId, userId } = request.businessContext;
    return this.integrationsService.completeWhatsAppSignup(businessId, userId, body ?? {});
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
