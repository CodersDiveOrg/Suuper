import axios, { type AxiosRequestConfig } from "axios";
import { assertPublicUrl, guardedHttpAgent, guardedHttpsAgent } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";

const config = loadServiceConfig("bot-service", 3002);
const MAX_RESULT_CHARS = 12_000;

/** A provider-side failure with a readable message (becomes an is_error tool result). */
export class ActionError extends Error {}

/**
 * HTTP for integration actions. Several providers take a user-entered domain
 * (Shopify, WooCommerce, Jira…), so every request goes through the SSRF guard
 * like MCP does. Non-2xx responses throw ActionError with the provider's message.
 */
export async function request<T = unknown>(cfg: AxiosRequestConfig & { url: string }): Promise<T> {
  await assertPublicUrl(cfg.url, { allowPrivate: config.mcpAllowPrivateUrls });
  const response = await axios.request<T>({
    timeout: 20_000,
    maxContentLength: 5_000_000,
    validateStatus: () => true,
    ...(config.mcpAllowPrivateUrls ? {} : { httpAgent: guardedHttpAgent, httpsAgent: guardedHttpsAgent }),
    ...cfg,
    headers: { "User-Agent": "AiAutomationPlatform/1.0", ...(cfg.headers ?? {}) },
  });
  if (response.status >= 400) {
    throw new ActionError(`HTTP ${response.status}: ${describeError(response.data)}`);
  }
  return response.data;
}

function describeError(data: unknown): string {
  if (!data) return "request failed";
  if (typeof data === "string") return data.slice(0, 300);
  const d = data as Record<string, unknown>;
  const message = d.message ?? d.error_description ?? d.error ?? d.errors ?? d.detail ?? d.title;
  return (typeof message === "string" ? message : JSON.stringify(message ?? data)).slice(0, 300);
}

/** Results go back to the model, so keep them compact. */
export function result(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

export function basicAuth(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** "yourco.myshopify.com", "https://yourco.myshopify.com/" -> "https://yourco.myshopify.com" */
export function baseUrl(value: string) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}
