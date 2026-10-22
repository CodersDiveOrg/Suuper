import axios from "axios";
import nodemailer from "nodemailer";
import {
  guardedHttpAgent,
  guardedHttpsAgent,
  isBlockedLiteralHost,
  signBusinessToken,
} from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import type { KnowledgeSearchResult } from "@platform/shared-types";
import { integrationCredentials, type ProviderName } from "./models";
import type { ClientTool } from "./providers/types";

const config = loadServiceConfig("bot-service", 3002);

const MAX_EMAILS_PER_RUN = 3;
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_RESPONSE_CHARS = 20_000;

/** What a tool can see about the run it's part of. */
export interface ToolContext {
  businessId: string;
  knowledgeBaseIds: string[];
  /** Mutable per-run counters (e.g. emails sent), shared across tool calls. */
  counters: Record<string, number>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

interface ToolSpec<T> {
  key: string;
  label: string;
  description: string;
  /** "client": runs here. "server": hosted by the model provider (Claude only). */
  kind: "client" | "server";
  providers: ProviderName[];
  /** Shown in the UI when a precondition isn't met. */
  requires?: string;
  definition?: ClientTool;
  validate?: (input: unknown) => Validated<T>;
  run?: (ctx: ToolContext, input: T) => Promise<ToolResult>;
}

// --- input helpers ----------------------------------------------------------

function obj(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

function str(o: Record<string, unknown>, key: string, { required = true, max = 10_000 } = {}): string | undefined | Error {
  const value = o[key];
  if (value === undefined || value === null || value === "") {
    return required ? new Error(`${key} is required`) : undefined;
  }
  if (typeof value !== "string") return new Error(`${key} must be a string`);
  if (value.length > max) return new Error(`${key} must be at most ${max} characters`);
  return value;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// --- tools ---------------------------------------------------------------------

const searchKnowledge: ToolSpec<{ query: string }> = {
  key: "search_knowledge",
  label: "Search knowledge bases",
  description: "Look things up in the knowledge bases attached to this agent.",
  kind: "client",
  providers: ["anthropic", "ollama"],
  requires: "At least one knowledge base attached to the agent",
  definition: {
    name: "search_knowledge",
    description:
      "Search the business's knowledge bases (product catalog, documents, FAQs and website pages) for anything relevant to a query. Returns matching products (title, price, URL, description) and passages (title, source URL, text). Use it whenever the user asks about products, prices, policies, services or anything else about the business.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for, in natural language." } },
      required: ["query"],
    },
  },
  validate: (input) => {
    const o = obj(input);
    const query = o && str(o, "query", { max: 500 });
    if (!o || query instanceof Error || !query) return { ok: false, error: query instanceof Error ? query.message : "query is required" };
    return { ok: true, value: { query } };
  },
  run: async (ctx, { query }) => {
    if (ctx.knowledgeBaseIds.length === 0) {
      return { content: "This agent has no knowledge bases attached.", isError: true };
    }
    // Short-lived internal token, so this works the same for chat and future scheduled runs.
    const token = signBusinessToken({
      userId: "agent-runtime",
      businessId: ctx.businessId,
      role: "member",
      permissions: ["knowledge:read"],
    });
    const response = await axios.post<KnowledgeSearchResult>(
      `${config.knowledgeServiceUrl}/businesses/current/knowledge-bases/search`,
      { query, knowledgeBaseIds: ctx.knowledgeBaseIds },
      { headers: { Authorization: `Bearer ${token}` }, timeout: HTTP_TIMEOUT_MS },
    );
    const products = (response.data.products ?? []).slice(0, 8).map((p) => ({
      title: p.title,
      price: p.price !== undefined ? `${p.price} ${p.currency ?? ""}`.trim() : undefined,
      url: p.productUrl,
      description: p.description?.slice(0, 400),
    }));
    const passages = (response.data.passages ?? []).map((p) => ({ title: p.title, url: p.sourceUrl, text: p.content }));
    if (products.length === 0 && passages.length === 0) return { content: "No matching items found." };
    return { content: JSON.stringify({ products, passages }) };
  },
};

const sendEmail: ToolSpec<{ to: string; subject: string; body: string }> = {
  key: "send_email",
  label: "Send email",
  description: `Send plain-text emails through the business's Email (SMTP) integration. Max ${MAX_EMAILS_PER_RUN} per run.`,
  kind: "client",
  providers: ["anthropic", "ollama"],
  requires: "The Email (SMTP) integration connected",
  definition: {
    name: "send_email",
    description: `Send a plain-text email from the business's own email account. Only send when the user has clearly asked for an email to be sent, to the address they specified. At most ${MAX_EMAILS_PER_RUN} emails per request.`,
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
      },
      required: ["to", "subject", "body"],
    },
  },
  validate: (input) => {
    const o = obj(input);
    if (!o) return { ok: false, error: "input must be an object" };
    const to = str(o, "to", { max: 254 });
    const subject = str(o, "subject", { max: 200 });
    const body = str(o, "body", { max: 20_000 });
    for (const v of [to, subject, body]) if (v instanceof Error || !v) return { ok: false, error: v instanceof Error ? v.message : "missing field" };
    if (!EMAIL_RE.test(to as string)) return { ok: false, error: "to must be a single valid email address" };
    return { ok: true, value: { to: to as string, subject: subject as string, body: body as string } };
  },
  run: async (ctx, { to, subject, body }) => {
    if ((ctx.counters.emails ?? 0) >= MAX_EMAILS_PER_RUN) {
      return { content: `Email limit reached (${MAX_EMAILS_PER_RUN} per run). Not sent.`, isError: true };
    }
    const smtp = await integrationCredentials(ctx.businessId, "smtp");
    if (!smtp) return { content: "The Email (SMTP) integration isn't connected or is paused.", isError: true };
    const port = Number(smtp.port || 587);
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port,
      secure: port === 465,
      auth: { user: smtp.username, pass: smtp.password },
    });
    await transport.sendMail({ from: smtp.fromAddress, to, subject, text: body });
    ctx.counters.emails = (ctx.counters.emails ?? 0) + 1;
    return { content: `Email sent to ${to}.` };
  },
};

const httpRequest: ToolSpec<{ url: string; method: "GET" | "POST"; body?: string }> = {
  key: "http_request",
  label: "HTTP request",
  description: "Call public web APIs (GET/POST). Internal and private network addresses are blocked.",
  kind: "client",
  providers: ["anthropic", "ollama"],
  definition: {
    name: "http_request",
    description:
      "Make an HTTP GET or POST request to a public URL and return the response (truncated to 20,000 characters). Use for public JSON APIs and web pages. Private/internal addresses are blocked.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        method: { type: "string", enum: ["GET", "POST"] },
        body: { type: "string", description: "Request body for POST (sent as JSON if it parses, else text)." },
      },
      required: ["url", "method"],
    },
  },
  validate: (input) => {
    const o = obj(input);
    if (!o) return { ok: false, error: "input must be an object" };
    const url = str(o, "url", { max: 2000 });
    if (url instanceof Error || !url) return { ok: false, error: url instanceof Error ? url.message : "url is required" };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "url must be an absolute URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "only http and https URLs are allowed" };
    if (parsed.username || parsed.password) return { ok: false, error: "credentials in URLs are not allowed" };
    if (isBlockedLiteralHost(parsed.hostname)) return { ok: false, error: "private and internal addresses are blocked" };
    const method = o.method === "POST" ? "POST" : o.method === "GET" || o.method === undefined ? "GET" : null;
    if (!method) return { ok: false, error: "method must be GET or POST" };
    const body = str(o, "body", { required: false, max: 20_000 });
    if (body instanceof Error) return { ok: false, error: body.message };
    return { ok: true, value: { url, method, body } };
  },
  run: async (_ctx, { url, method, body }) => {
    let data: unknown = body;
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        // send as plain text
      }
    }
    const response = await axios.request({
      url,
      method,
      data,
      httpAgent: guardedHttpAgent,
      httpsAgent: guardedHttpsAgent,
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 3,
      // Hostnames on every hop go through the guarded lookup; literal IPs are checked here.
      beforeRedirect: (options: { hostname?: string }) => {
        if (options.hostname && isBlockedLiteralHost(options.hostname)) {
          throw new Error("Redirect to a private address was blocked");
        }
      },
      maxContentLength: 2_000_000,
      responseType: "text",
      transformResponse: (r) => r,
      validateStatus: () => true,
      headers: { "User-Agent": "AgentRuntime/1.0" },
    });
    const text = String(response.data ?? "");
    const truncated = text.length > HTTP_MAX_RESPONSE_CHARS ? `${text.slice(0, HTTP_MAX_RESPONSE_CHARS)}\n…[truncated]` : text;
    return {
      content: `HTTP ${response.status}\nContent-Type: ${response.headers["content-type"] ?? "unknown"}\n\n${truncated}`,
      isError: response.status >= 400,
    };
  },
};

const currentTime: ToolSpec<{ timezone?: string }> = {
  key: "current_time",
  label: "Current date & time",
  description: "Lets the agent know today's date and time.",
  kind: "client",
  providers: ["anthropic", "ollama"],
  definition: {
    name: "current_time",
    description: "Get the current date and time, optionally in an IANA timezone like Europe/London.",
    input_schema: { type: "object", properties: { timezone: { type: "string" } } },
  },
  validate: (input) => {
    const o = obj(input) ?? {};
    const timezone = str(o, "timezone", { required: false, max: 64 });
    if (timezone instanceof Error) return { ok: false, error: timezone.message };
    return { ok: true, value: { timezone } };
  },
  run: async (_ctx, { timezone }) => {
    const now = new Date();
    try {
      const local = now.toLocaleString("en-GB", { timeZone: timezone || "UTC", dateStyle: "full", timeStyle: "long" });
      return { content: `${local} (ISO ${now.toISOString()})` };
    } catch {
      return { content: `Unknown timezone "${timezone}". UTC now: ${now.toISOString()}`, isError: true };
    }
  },
};

const webSearch: ToolSpec<unknown> = {
  key: "web_search",
  label: "Web search",
  description: "Search the web for up-to-date information (Claude models only).",
  kind: "server",
  providers: ["anthropic"],
};

const webFetch: ToolSpec<unknown> = {
  key: "web_fetch",
  label: "Read web pages",
  description: "Read the full content of web pages found by search or given by the user (Claude models only).",
  kind: "server",
  providers: ["anthropic"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: ToolSpec<any>[] = [searchKnowledge, currentTime, webSearch, webFetch, httpRequest, sendEmail];

export function toolCatalog() {
  return TOOLS.map(({ key, label, description, kind, providers, requires }) => ({
    key,
    label,
    description,
    kind,
    providers,
    requires,
  }));
}

export function isToolKey(key: string) {
  return TOOLS.some((t) => t.key === key);
}

/** Split an agent's enabled tools into client definitions + provider-hosted keys for a provider. */
export function toolsFor(keys: string[], provider: ProviderName) {
  const enabled = TOOLS.filter((t) => keys.includes(t.key) && t.providers.includes(provider));
  return {
    clientTools: enabled.flatMap((t) => (t.kind === "client" && t.definition ? [t.definition] : [])),
    serverTools: enabled.filter((t) => t.kind === "server").map((t) => t.key),
  };
}

/** Validate + run one client tool call. Never throws: failures become error results. */
export async function executeTool(ctx: ToolContext, enabledKeys: string[], name: string, input: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.kind === "client" && t.definition?.name === name);
  if (!tool || !enabledKeys.includes(tool.key) || !tool.validate || !tool.run) {
    return { content: `Unknown or disabled tool: ${name}`, isError: true };
  }
  const parsed = tool.validate(input);
  if (!parsed.ok) return { content: `Invalid input: ${parsed.error}`, isError: true };
  try {
    return await tool.run(ctx, parsed.value);
  } catch (err) {
    return { content: `Tool failed: ${(err as Error).message}`, isError: true };
  }
}
