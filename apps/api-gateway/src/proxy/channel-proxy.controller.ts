import { All, Controller, Req, Res, type RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import axios, { type Method } from "axios";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

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

// Public WhatsApp/Telegram webhooks. Unlike forwardTo this passes the body
// through byte for byte (WhatsApp signs the raw body) along with the
// providers' auth headers, and relays the reply as-is (WhatsApp's verify
// handshake expects the challenge back as plain text).
@Controller("hooks/channels")
export class ChannelWebhookProxyController {
  @All(["", "*"])
  async handle(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "x-hub-signature-256", "x-telegram-bot-api-secret-token"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    try {
      const upstream = await axios.request({
        method: req.method as Method,
        url: `${botServiceUrl}${req.originalUrl}`,
        data: req.rawBody,
        headers,
        responseType: "text",
        transformResponse: (data) => data,
        validateStatus: () => true,
      });
      const contentType = upstream.headers["content-type"];
      if (contentType) res.setHeader("content-type", String(contentType));
      res.status(upstream.status).send(upstream.data);
    } catch {
      res.status(502).json({ message: "Service unavailable" });
    }
  }
}
