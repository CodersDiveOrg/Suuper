import axios, { type Method } from "axios";
import {
  assertPublicUrl,
  decryptJson,
  guardedHttpAgent,
  guardedHttpsAgent,
  isBlockedLiteralHost,
} from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import type { HostedToolParam } from "@platform/shared-types";

const config = loadServiceConfig("mcp-gateway", 3003);
const MAX_RESPONSE_CHARS = 50_000;

export interface HostedToolRow {
  name: string;
  parameters: unknown;
  method: string;
  urlTemplate: string;
  headers: unknown;
  secretHeadersEncrypted: string | null;
  timeoutMs: number;
}

/** Checks arguments against the tool's parameter list; light coercion for numbers/booleans given as strings. */
export function validateHostedArgs(params: HostedToolParam[], args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    let value = args[p.name];
    if (value === undefined || value === null || value === "") {
      if (p.required) throw new Error(`Missing required argument: ${p.name}`);
      continue;
    }
    if ((p.type === "number" || p.type === "integer") && typeof value === "string" && value.trim() !== "") value = Number(value);
    if (p.type === "boolean" && typeof value === "string") value = value === "true" ? true : value === "false" ? false : value;
    const ok =
      p.type === "string"
        ? typeof value === "string"
        : p.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "number" && Number.isFinite(value) && (p.type === "number" || Number.isInteger(value));
    if (!ok) throw new Error(`Argument ${p.name} must be a ${p.type}`);
    if (p.enum?.length && !p.enum.includes(String(value))) throw new Error(`Argument ${p.name} must be one of: ${p.enum.join(", ")}`);
    out[p.name] = value;
  }
  const unknown = Object.keys(args).filter((k) => !params.some((p) => p.name === k));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  return out;
}

/**
 * Runs a hosted tool: fills {{param}} placeholders in the URL (URL-encoded);
 * remaining arguments go in the query string for GET/DELETE, or as a JSON body
 * otherwise. Returns the response as text (pretty-printed when JSON).
 */
export async function executeHostedTool(tool: HostedToolRow, rawArgs: Record<string, unknown>) {
  const params = tool.parameters as HostedToolParam[];
  const args = validateHostedArgs(params, rawArgs);

  const used = new Set<string>();
  const urlString = tool.urlTemplate.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    used.add(name);
    return args[name] === undefined ? "" : encodeURIComponent(String(args[name]));
  });
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
  const url = await assertPublicUrl(urlString, { allowPrivate: config.mcpAllowPrivateUrls });

  const method = tool.method.toUpperCase();
  const sendsBody = !["GET", "DELETE"].includes(method);
  if (!sendsBody) for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = {
    "User-Agent": "AiAutomationPlatform-MCP/1.0",
    ...(tool.headers as Record<string, string>),
    ...(tool.secretHeadersEncrypted ? decryptJson<Record<string, string>>(tool.secretHeadersEncrypted) : {}),
  };

  const guarded = !config.mcpAllowPrivateUrls;
  const response = await axios.request({
    url: url.toString(),
    method: method as Method,
    data: sendsBody && Object.keys(rest).length ? rest : undefined,
    headers,
    timeout: tool.timeoutMs,
    maxRedirects: 3,
    maxContentLength: 2_000_000,
    responseType: "text",
    transformResponse: (r) => r,
    validateStatus: () => true,
    ...(guarded
      ? {
          httpAgent: guardedHttpAgent,
          httpsAgent: guardedHttpsAgent,
          beforeRedirect: (options: { hostname?: string }) => {
            if (options.hostname && isBlockedLiteralHost(options.hostname)) throw new Error("Redirect to a private address was blocked");
          },
        }
      : {}),
  });

  let body = String(response.data ?? "");
  try {
    body = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // not JSON — keep as text
  }
  if (body.length > MAX_RESPONSE_CHARS) body = `${body.slice(0, MAX_RESPONSE_CHARS)}\n…[truncated]`;
  return { content: `HTTP ${response.status}\n\n${body}`, isError: response.status >= 400 };
}
