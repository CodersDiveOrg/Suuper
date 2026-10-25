import { All, Controller, Req } from "@nestjs/common";
import type { Request } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

// Outgoing webhooks (endpoints, delivery log) and usage live in bot-service.
const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Registered before BusinessesProxyController so this path wins over "businesses/*".
@Controller("businesses/current/webhooks")
export class WebhooksProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Usage metering and plans also live in bot-service, which records most of the usage.
@Controller("businesses/current/usage")
export class UsageProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}
