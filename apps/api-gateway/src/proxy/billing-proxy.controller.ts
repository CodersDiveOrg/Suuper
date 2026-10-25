import { All, Controller, Req, Res, type RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";
import { relayRaw } from "./raw-relay";

// Billing runs in bot-service, next to the plans and usage limits it changes.
const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Registered before BusinessesProxyController (see app.module.ts) so this
// more specific path wins over the generic "businesses/*" forward.
@Controller("businesses/current/billing")
export class BillingProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Settings → AI Models: provider keys and the default model, next to the providers that use them.
@Controller("businesses/current/ai-models")
export class AiModelsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Public Stripe webhook: Stripe signs the raw body (stripe-signature header).
@Controller("hooks/billing")
export class BillingWebhookProxyController {
  @All(["", "*"])
  handle(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return relayRaw(botServiceUrl, req, res, ["stripe-signature"]);
  }
}
