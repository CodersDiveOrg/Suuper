import { All, Controller, Req } from "@nestjs/common";
import type { Request } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

// Workflows run in bot-service, next to the integration actions they call.
const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Registered before BusinessesProxyController (see app.module.ts) so this
// more specific path wins over the generic "businesses/*" forward.
@Controller("businesses/current/workflows")
export class WorkflowsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Public workflow webhooks — no Authorization header; bot-service resolves the
// workflow from the key in the path.
@Controller("hooks/workflows")
export class WorkflowWebhookProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}
