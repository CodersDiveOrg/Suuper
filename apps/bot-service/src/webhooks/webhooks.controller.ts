import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { WebhooksService, type EndpointInput } from "./webhooks.service";

type Ctx = { businessContext: BusinessContext };

// Static paths (events, deliveries/…) are declared before ":id".
@Controller("businesses/current/webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @RequirePermission("webhooks:read")
  list(@Req() req: Ctx) {
    return this.webhooks.list(req.businessContext.businessId);
  }

  @Get("events")
  @RequirePermission("webhooks:read")
  events() {
    return this.webhooks.events();
  }

  @Get("deliveries/:deliveryId")
  @RequirePermission("webhooks:read")
  delivery(@Req() req: Ctx, @Param("deliveryId") deliveryId: string) {
    return this.webhooks.delivery(req.businessContext.businessId, deliveryId);
  }

  @Post("deliveries/:deliveryId/redeliver")
  @RequirePermission("webhooks:write")
  redeliver(@Req() req: Ctx, @Param("deliveryId") deliveryId: string) {
    return this.webhooks.redeliver(req.businessContext.businessId, deliveryId);
  }

  @Post()
  @RequirePermission("webhooks:write")
  create(@Req() req: Ctx, @Body() body: EndpointInput) {
    const { businessId, userId } = req.businessContext;
    return this.webhooks.create(businessId, userId, body ?? {});
  }

  @Get(":id")
  @RequirePermission("webhooks:read")
  get(@Req() req: Ctx, @Param("id") id: string) {
    return this.webhooks.get(req.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("webhooks:write")
  update(@Req() req: Ctx, @Param("id") id: string, @Body() body: EndpointInput) {
    return this.webhooks.update(req.businessContext.businessId, id, body ?? {});
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("webhooks:write")
  async remove(@Req() req: Ctx, @Param("id") id: string) {
    await this.webhooks.remove(req.businessContext.businessId, id);
  }

  @Get(":id/secret")
  @RequirePermission("webhooks:write")
  secret(@Req() req: Ctx, @Param("id") id: string) {
    return this.webhooks.secret(req.businessContext.businessId, id);
  }

  @Post(":id/secret/rotate")
  @RequirePermission("webhooks:write")
  rotateSecret(@Req() req: Ctx, @Param("id") id: string) {
    return this.webhooks.rotateSecret(req.businessContext.businessId, id);
  }

  @Post(":id/test")
  @RequirePermission("webhooks:write")
  test(@Req() req: Ctx, @Param("id") id: string, @Body() body: { eventType?: unknown }) {
    return this.webhooks.test(req.businessContext.businessId, id, body?.eventType);
  }

  @Get(":id/deliveries")
  @RequirePermission("webhooks:read")
  deliveries(
    @Req() req: Ctx,
    @Param("id") id: string,
    @Query("status") status?: string,
    @Query("eventType") eventType?: string,
    @Query("before") before?: string,
  ) {
    return this.webhooks.deliveries(req.businessContext.businessId, id, { status, eventType, before });
  }
}
