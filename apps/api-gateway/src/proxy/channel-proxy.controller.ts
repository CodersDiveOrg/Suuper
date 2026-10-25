import { All, Controller, Req, Res, type RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";
import { relayRaw } from "./raw-relay";

// Channels run in bot-service, next to the bots that answer them.
const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Registered before BusinessesProxyController (see app.module.ts) so this
// more specific path wins over the generic "businesses/*" forward.
@Controller("businesses/current/channels")
export class ChannelsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// The bots' conversation inbox lives in bot-service with the chat logs.
@Controller("businesses/current/conversations")
export class ConversationsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Public WhatsApp/Telegram webhooks, relayed byte for byte (WhatsApp signs the raw body).
@Controller("hooks/channels")
export class ChannelWebhookProxyController {
  @All(["", "*"])
  handle(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return relayRaw(botServiceUrl, req, res, ["x-hub-signature-256", "x-telegram-bot-api-secret-token"]);
  }
}
