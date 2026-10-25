import { prisma } from "./client";

// The audit log: who changed what in a business. Each service mounts
// auditMiddleware, which records every successful POST/PATCH/PUT/DELETE a
// member makes under /businesses/current/... . Routes are recognised from the
// URL, so new endpoints are covered without extra code; data edits that have
// their own history (app records, chats) are left out on purpose.

/** Minimal Express shapes, so this package doesn't depend on express. */
interface AuditRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
  businessContext?: { businessId: string; userId: string };
}
interface AuditResponse {
  statusCode: number;
  json: (body: unknown) => unknown;
  on: (event: "finish", listener: () => void) => unknown;
}

type Lookup = (id: string, businessId: string) => Promise<string | undefined | null>;

interface ResourceDef {
  type: string;
  lookup?: Lookup;
  /** Collections that never take an id ("usage/plan"). */
  noIds?: boolean;
}

// URL collection segment -> resource. Nested collections (documents under a
// knowledge base) win over their parent.
const RESOURCES: Record<string, ResourceDef> = {
  bots: { type: "bot", lookup: async (id) => (await prisma.bot.findUnique({ where: { id }, select: { name: true } }))?.name },
  agents: { type: "agent", lookup: async (id) => (await prisma.agent.findUnique({ where: { id }, select: { name: true } }))?.name },
  "agent-skills": { type: "skill", lookup: async (id) => (await prisma.agentSkill.findUnique({ where: { id }, select: { name: true } }))?.name },
  "agent-schedules": {
    type: "schedule",
    lookup: async (id) => (await prisma.agentSchedule.findUnique({ where: { id }, select: { name: true } }))?.name,
  },
  workflows: { type: "workflow", lookup: async (id) => (await prisma.workflow.findUnique({ where: { id }, select: { name: true } }))?.name },
  apps: { type: "app", lookup: async (id) => (await prisma.app.findUnique({ where: { id }, select: { name: true } }))?.name },
  "knowledge-bases": {
    type: "knowledge_base",
    lookup: async (id) => (await prisma.knowledgeBase.findUnique({ where: { id }, select: { name: true } }))?.name,
  },
  documents: {
    type: "document",
    lookup: async (id) => (await prisma.knowledgeDocument.findUnique({ where: { id }, select: { title: true } }))?.title,
  },
  "mcp-servers": { type: "mcp_server", lookup: async (id) => (await prisma.mcpServer.findUnique({ where: { id }, select: { name: true } }))?.name },
  "hosted-tools": {
    type: "mcp_tool",
    lookup: async (id) => (await prisma.mcpHostedTool.findUnique({ where: { id }, select: { name: true } }))?.name,
  },
  webhooks: { type: "webhook", lookup: async (id) => (await prisma.webhookEndpoint.findUnique({ where: { id }, select: { url: true } }))?.url },
  deliveries: {
    type: "webhook_delivery",
    lookup: async (id) => (await prisma.webhookDelivery.findUnique({ where: { id }, select: { eventType: true } }))?.eventType,
  },
  members: {
    type: "member",
    lookup: async (id) => {
      const user = await prisma.user.findUnique({ where: { id }, select: { name: true, email: true } });
      return user ? user.name || user.email : undefined;
    },
  },
  invitations: { type: "invitation", lookup: async (id) => (await prisma.invitation.findUnique({ where: { id }, select: { email: true } }))?.email },
  roles: {
    type: "role",
    lookup: async (key, businessId) =>
      (await prisma.role.findUnique({ where: { businessId_key: { businessId, key } }, select: { name: true } }))?.name ?? key,
  },
  // Keyed by provider ("slack", "whatsapp"), which is also the name shown.
  integrations: { type: "integration", lookup: async (provider) => provider },
  channels: { type: "channel", lookup: async (provider) => provider },
  usage: { type: "plan", noIds: true },
  // The bots inbox (businesses/current/conversations). Conversations have no name.
  conversations: { type: "conversation" },
};

// Paths that aren't configuration changes (chats, record edits with their own
// history, searches and AI helpers, tests) or that are signed with a user token.
const SKIPPED = new Set(["records", "comments", "messages", "search", "ai", "suggest", "forms", "onboarding", "call", "test", "accept", "register"]);

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Sub-actions after an item ("bots/:id/widget/regenerate-key") -> verb.
const SUB_ACTIONS: Record<string, string> = {
  widget: "widget_updated",
  "widget/regenerate-key": "widget_key_regenerated",
  run: "run_started",
  "webhook/regenerate": "webhook_url_regenerated",
  reprocess: "resynced",
  sync: "synced",
  "secret/rotate": "secret_rotated",
  "access-key": "access_key_created",
  refresh: "tools_refreshed",
  resend: "resent",
  redeliver: "redelivered",
  samples: "sample_data_removed",
  plan: "changed",
  reply: "replied",
  takeover: "takeover_changed",
};

// Body fields whose values are safe and useful to keep; every other changed field is kept by name only.
const VALUE_FIELDS = new Set(["role", "enabled", "plan", "name", "title", "model", "autoSync", "status", "trigger", "active", "takeover"]);
// Never kept, not even by name.
const HIDDEN_FIELDS = /secret|token|password|apikey|api_key|credential|database64/i;

export interface AuditTarget {
  resourceType: string;
  resourceId?: string;
  action: string;
  lookup?: Lookup;
}

/** Works out what a request does from its method and URL, or null when it isn't audited. */
export function describeRequest(method: string, url: string): AuditTarget | null {
  const path = url.split("?")[0].replace(/\/+$/, "");
  const prefix = "/businesses/current";
  if (!path.startsWith(prefix)) return null;
  const segments = path.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.some((s) => SKIPPED.has(s))) return null;
  // An agent's own chats aren't configuration; the shared conversations inbox is.
  if (segments[0] === "agents" && segments.includes("conversations")) return null;

  // Workspace settings: /businesses/current/profile.
  if (segments.length === 0 || segments[0] === "profile") {
    return method === "PATCH" ? { resourceType: "workspace", action: "workspace.updated" } : null;
  }

  let resource: ResourceDef | undefined;
  let id: string | undefined;
  let i = 0;
  while (i < segments.length) {
    const def = RESOURCES[segments[i]];
    if (!def) break;
    resource = def;
    id = undefined;
    i++;
    if (!def.noIds && i < segments.length && !RESOURCES[segments[i]]) {
      id = segments[i];
      i++;
    }
  }
  if (!resource) return null;
  const sub = segments.slice(i).join("/");
  const type = resource.type;

  let verb: string;
  if (sub) {
    verb = SUB_ACTIONS[sub] ?? sub.replace(/[^a-z0-9]+/gi, "_");
  } else if (method === "DELETE") {
    verb = { member: "removed", invitation: "revoked", integration: "disconnected", channel: "removed" }[type] ?? "deleted";
  } else if (method === "POST" && !id) {
    verb = type === "invitation" ? "sent" : "created";
  } else {
    verb = { integration: "connected", channel: "saved" }[type] ?? "updated";
  }
  return { resourceType: type, resourceId: id, action: `${type}.${verb}`, lookup: id ? resource.lookup : undefined };
}

/** Changed field names, with values only for harmless fields. */
function detailsFrom(method: string, body: unknown): Record<string, unknown> | undefined {
  if ((method !== "PATCH" && method !== "PUT") || !body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const changed: string[] = [];
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (HIDDEN_FIELDS.test(key)) continue;
    changed.push(key);
    const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
    if (VALUE_FIELDS.has(key) && scalar) values[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  if (changed.length === 0) return undefined;
  return Object.keys(values).length ? { changed, values } : { changed };
}

/** The business in a bearer token, without verifying it (the service's guard does that). */
function peekBusinessId(authorization: string | string[] | undefined): string | undefined {
  const token = typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : "";
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { typ?: string; businessId?: string };
    return data.typ === "business" ? data.businessId : undefined;
  } catch {
    return undefined;
  }
}

function nameFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const value = b.name ?? b.title ?? b.email ?? b.url ?? b.fileName;
  return typeof value === "string" ? value : undefined;
}

function header(req: AuditRequest, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export interface AuditEventInput {
  businessId: string;
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Writes one event; never throws (a lost audit row must not fail the change itself). */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    const actor = event.actorId
      ? await prisma.user.findUnique({ where: { id: event.actorId }, select: { name: true, email: true } })
      : null;
    await prisma.auditEvent.create({
      data: {
        businessId: event.businessId,
        actorId: event.actorId ?? null,
        actorName: actor ? actor.name || actor.email : null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        resourceName: event.resourceName?.slice(0, 300) ?? null,
        details: (event.details as object | undefined) ?? undefined,
        ip: event.ip?.slice(0, 100) ?? null,
        userAgent: event.userAgent?.slice(0, 300) ?? null,
      },
    });
  } catch (err) {
    console.warn(`[audit] couldn't record ${event.action} for ${event.businessId}: ${(err as Error).message}`);
  }
}

/** Client IP and browser as forwarded by api-gateway. */
export function requestOrigin(req: Pick<AuditRequest, "headers" | "ip">) {
  const forwarded = header(req as AuditRequest, "x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || req.ip || null, userAgent: header(req as AuditRequest, "user-agent") ?? null };
}

/**
 * Express middleware (app.use in each service's main.ts). The item's name is
 * looked up before the handler runs, so deletes still have one; the event is
 * written once the response finished successfully for a member of that business.
 */
export function auditMiddleware(req: AuditRequest, res: AuditResponse, next: () => void) {
  if (!MUTATING.has(req.method)) return next();
  const target = describeRequest(req.method, req.originalUrl);
  const businessId = target ? peekBusinessId(req.headers.authorization) : undefined;
  if (!target || !businessId) return next();

  let responseBody: unknown;
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    responseBody = body;
    return json(body);
  };

  const lookup = target.lookup && target.resourceId ? target.lookup(target.resourceId, businessId).catch(() => undefined) : Promise.resolve(undefined);

  void lookup.then((nameBefore) => {
    res.on("finish", () => {
      const ctx = req.businessContext;
      if (res.statusCode >= 400 || !ctx || ctx.businessId !== businessId) return;
      // Read here, not up front: this middleware runs before Nest's body parser.
      const details = detailsFrom(req.method, req.body);
      const created = nameFromBody(responseBody);
      const id = target.resourceId ?? (responseBody && typeof responseBody === "object" ? ((responseBody as { id?: unknown }).id as string | undefined) : undefined);
      void recordAuditEvent({
        businessId,
        actorId: ctx.userId,
        action: target.action,
        resourceType: target.resourceType,
        resourceId: typeof id === "string" ? id : null,
        resourceName: nameBefore ?? created ?? (target.resourceType === "plan" ? (details?.values as { plan?: string })?.plan : undefined),
        details,
        ...requestOrigin(req),
      });
    });
    next();
  });
}
