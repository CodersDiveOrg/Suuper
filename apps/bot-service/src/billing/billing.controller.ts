import { Body, Controller, Get, Headers, HttpCode, Post, Req, type RawBodyRequest } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import type { Request } from "express";
import { BillingService } from "./billing.service";

type Ctx = { businessContext: BusinessContext };

@Controller("businesses/current/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  // Everyone sees the plan; invoices are left out unless the caller can manage billing.
  @Get()
  @RequirePermission("business:read")
  overview(@Req() req: Ctx) {
    return this.billing.overview(req.businessContext);
  }

  @Post("checkout")
  @RequirePermission("business:manage")
  checkout(@Req() req: Ctx, @Body() body: { plan?: unknown }) {
    return this.billing.checkout(req.businessContext, body?.plan);
  }

  @Post("portal")
  @RequirePermission("business:manage")
  portal(@Req() req: Ctx) {
    return this.billing.portal(req.businessContext);
  }

  @Post("cancel")
  @HttpCode(200)
  @RequirePermission("business:manage")
  cancel(@Req() req: Ctx) {
    return this.billing.setCancelAtPeriodEnd(req.businessContext, true);
  }

  @Post("resume")
  @HttpCode(200)
  @RequirePermission("business:manage")
  resume(@Req() req: Ctx) {
    return this.billing.setCancelAtPeriodEnd(req.businessContext, false);
  }
}

// Public — called by Stripe; the stripe-signature header over the raw body proves it.
@Controller("hooks/billing/stripe")
export class StripeWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers("stripe-signature") signature?: string) {
    return this.billing.handleWebhook(req.rawBody, signature);
  }
}
