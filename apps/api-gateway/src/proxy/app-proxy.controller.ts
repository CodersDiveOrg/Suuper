import { All, Controller, Req } from "@nestjs/common";
import type { Request } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

// Apps live in bot-service, next to the bots and workflows they're built from.
const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Registered before BusinessesProxyController (see app.module.ts) so this
// more specific path wins over the generic "businesses/*" forward.
@Controller("businesses/current/apps")
export class AppsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Hosted app pages (/a/<slug> in the web app) — no Authorization header.
@Controller("public/apps")
export class PublicAppsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}
