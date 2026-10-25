import type { RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import axios, { type Method } from "axios";

/**
 * For public provider webhooks (WhatsApp, Telegram, Stripe). Unlike forwardTo
 * this passes the body through byte for byte, since providers sign the raw body,
 * along with the named auth headers, and relays the reply as-is: WhatsApp's verify
 * handshake expects the challenge back as plain text.
 */
export async function relayRaw(targetServiceUrl: string, req: RawBodyRequest<Request>, res: Response, headerNames: string[]) {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", ...headerNames]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  try {
    const upstream = await axios.request({
      method: req.method as Method,
      url: `${targetServiceUrl}${req.originalUrl}`,
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
