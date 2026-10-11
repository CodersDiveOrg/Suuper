import { HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import axios, { AxiosError, type Method } from "axios";

// Shared by every proxy controller: api-gateway is the only publicly
// reachable service, so each one just forwards to its target service
// unchanged — the downstream service enforces the JWT + permission checks.
export async function forwardTo(targetServiceUrl: string, req: Request) {
  try {
    const headers: Record<string, string> = {};
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    // Only the public widget route reads this (see WidgetKeyGuard) — harmless
    // to forward for every other, JWT-authenticated proxy too.
    if (req.headers.origin) headers.Origin = req.headers.origin;

    const response = await axios.request({
      method: req.method as Method,
      url: `${targetServiceUrl}${req.originalUrl}`,
      data: req.body,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      validateStatus: () => true,
    });
    if (response.status >= 400) {
      throw new HttpException(response.data ?? { message: "Upstream error" }, response.status);
    }
    return response.data;
  } catch (err) {
    if (err instanceof HttpException) throw err;
    const error = err as AxiosError;
    throw new HttpException(
      (error.response?.data as object) ?? { message: "Service unavailable" },
      error.response?.status ?? 502,
    );
  }
}

/**
 * Pipes the upstream response through untouched (status, content type, body
 * as it arrives). Used for Server-Sent Events, where buffering the whole body
 * like forwardTo does would hold every event until the run finishes.
 */
export async function streamTo(targetServiceUrl: string, req: Request, res: Response) {
  const headers: Record<string, string> = { Accept: req.headers.accept ?? "application/json" };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  // MCP clients (hosted servers at /mcp/:id) negotiate with these.
  for (const name of ["content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }

  const controller = new AbortController();
  // Client went away: stop reading upstream. (The agent run itself keeps going
  // and is persisted; this only stops relaying events.)
  res.on("close", () => controller.abort());

  try {
    const upstream = await axios.request({
      method: req.method as Method,
      url: `${targetServiceUrl}${req.originalUrl}`,
      data: req.body,
      headers,
      responseType: "stream",
      validateStatus: () => true,
      signal: controller.signal,
    });
    res.status(upstream.status);
    for (const name of ["content-type", "cache-control", "x-accel-buffering", "mcp-session-id", "www-authenticate", "allow"]) {
      const value = upstream.headers[name];
      if (value) res.setHeader(name, String(value));
    }
    res.flushHeaders();
    upstream.data.pipe(res);
  } catch (err) {
    if (res.headersSent) return res.end();
    const error = err as AxiosError;
    res.status(error.response?.status ?? 502).json({ message: "Service unavailable" });
  }
}
