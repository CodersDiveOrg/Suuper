import { All, Controller, Req } from "@nestjs/common";
import type { Request } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Public embed widget traffic — no Authorization header, forwarded to
// bot-service's WidgetController which authorizes via the widgetKey + Origin.
@Controller("public/widget")
export class WidgetProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}
