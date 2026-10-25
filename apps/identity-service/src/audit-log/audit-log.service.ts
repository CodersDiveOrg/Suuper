import { BadRequestException, Injectable } from "@nestjs/common";
import { prisma, type Prisma } from "@platform/database";

const PAGE_SIZE = 50;
const MAX_EXPORT = 10_000;

export interface AuditFilters {
  actorId?: string;
  resourceType?: string;
  action?: string;
  q?: string;
  from?: string;
  to?: string;
  before?: string;
}

const RESOURCE_LABELS: Record<string, string> = {
  bot: "bot",
  agent: "agent",
  skill: "skill",
  schedule: "schedule",
  workflow: "workflow",
  app: "app",
  knowledge_base: "knowledge base",
  document: "document",
  mcp_server: "MCP server",
  mcp_tool: "MCP tool",
  webhook: "webhook endpoint",
  webhook_delivery: "webhook delivery",
  member: "member",
  invitation: "invitation",
  role: "role",
  api_key: "API key",
  integration: "integration",
  channel: "channel",
  plan: "plan",
  workspace: "workspace settings",
  conversation: "conversation",
};

// "<Verb> <resource> “name”". Verbs that read better with "of"/"for" carry it.
const VERBS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  removed: "Removed",
  revoked: "Revoked",
  sent: "Sent",
  connected: "Connected",
  disconnected: "Disconnected",
  saved: "Saved",
  widget_updated: "Changed the website widget of",
  widget_key_regenerated: "Regenerated the widget key of",
  run_started: "Ran",
  webhook_url_regenerated: "Regenerated the webhook URL of",
  resynced: "Re-synced",
  synced: "Synced",
  secret_rotated: "Rotated the signing secret of",
  access_key_created: "Created an access key for",
  tools_refreshed: "Refreshed the tools of",
  resent: "Resent",
  redelivered: "Resent",
  sample_data_removed: "Removed the sample data from",
};

type EventRow = Prisma.AuditEventGetPayload<object>;
type Details = { changed?: string[]; values?: Record<string, unknown> } | null;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One sentence for the log, e.g. "Changed Sara's role to admin". */
export function summarize(event: Pick<EventRow, "action" | "resourceType" | "resourceName" | "details">): string {
  const verb = event.action.slice(event.action.indexOf(".") + 1);
  const details = event.details as Details;
  const values = details?.values ?? {};
  const name = event.resourceName ? `“${event.resourceName}”` : "";
  const resource = RESOURCE_LABELS[event.resourceType] ?? event.resourceType.replace(/_/g, " ");

  switch (event.action) {
    case "member.signed_in":
      return "Signed in";
    case "member.joined":
      return typeof values.role === "string" ? `Joined the workspace as ${values.role}` : "Joined the workspace";
    case "plan.changed":
      return typeof values.plan === "string" ? `Changed the plan to ${capitalize(values.plan)}` : "Changed the plan";
    case "workspace.updated":
      return "Updated the workspace settings";
    case "member.updated":
      if (typeof values.role === "string") return `Changed ${event.resourceName ?? "a member"}'s role to ${values.role}`;
      break;
    case "conversation.replied":
      return "Replied to a conversation";
    case "conversation.takeover_changed":
      // The inbox sends its on/off flag under one of these names.
      return [values.enabled, values.active, values.takeover].includes(false) ? "Handed a conversation back to the bot" : "Took over a conversation";
    case "conversation.deleted":
      return "Deleted a conversation";
    case "invitation.sent":
      return `Invited ${event.resourceName ?? "someone"}`;
    case "channel.saved":
    case "channel.removed":
    case "integration.connected":
    case "integration.disconnected": {
      const provider = event.resourceName ? capitalize(event.resourceName) : "a";
      return `${VERBS[verb]} the ${provider} ${resource}`;
    }
  }
  if (typeof values.enabled === "boolean" && details?.changed?.length === 1) {
    return `Turned ${values.enabled ? "on" : "off"} ${resource} ${name}`.trim();
  }
  const label = VERBS[verb] ?? capitalize(verb.replace(/_/g, " "));
  return `${label} ${resource} ${name}`.trim();
}

@Injectable()
export class AuditLogService {
  async list(businessId: string, filters: AuditFilters) {
    const rows = await prisma.auditEvent.findMany({
      where: this.where(businessId, filters),
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
    });
    const items = rows.slice(0, PAGE_SIZE).map(serialize);
    return { items, nextCursor: rows.length > PAGE_SIZE ? items[items.length - 1].createdAt : null };
  }

  /** Every matching event (up to 10,000), newest first, for a CSV download. */
  async export(businessId: string, filters: AuditFilters) {
    const rows = await prisma.auditEvent.findMany({
      where: this.where(businessId, { ...filters, before: undefined }),
      orderBy: { createdAt: "desc" },
      take: MAX_EXPORT,
    });
    return { items: rows.map(serialize), truncated: rows.length === MAX_EXPORT };
  }

  /** Who and what appear in the log, for the filter menus. */
  async facets(businessId: string) {
    const [actors, types] = await Promise.all([
      prisma.auditEvent.groupBy({
        by: ["actorId", "actorName"],
        where: { businessId, actorId: { not: null } },
        _max: { createdAt: true },
      }),
      prisma.auditEvent.groupBy({ by: ["resourceType"], where: { businessId }, _count: { _all: true } }),
    ]);
    // One entry per person, under the name they had most recently.
    const people = new Map<string, { id: string; name: string; last: Date }>();
    for (const a of actors) {
      const last = a._max.createdAt ?? new Date(0);
      const existing = people.get(a.actorId!);
      if (!existing || existing.last < last) people.set(a.actorId!, { id: a.actorId!, name: a.actorName ?? "Unknown", last });
    }
    return {
      actors: [...people.values()].map(({ id, name }) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)),
      resourceTypes: types
        .map((t) => ({ key: t.resourceType, label: capitalize(RESOURCE_LABELS[t.resourceType] ?? t.resourceType), count: t._count._all }))
        .sort((x, y) => x.label.localeCompare(y.label)),
    };
  }

  private where(businessId: string, f: AuditFilters): Prisma.AuditEventWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    const date = (value: string, name: string) => {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} must be a date`);
      return d;
    };
    if (f.from) createdAt.gte = date(f.from, "from");
    if (f.to) createdAt.lt = date(f.to, "to");
    if (f.before) {
      const before = date(f.before, "before");
      createdAt.lt = createdAt.lt && createdAt.lt < before ? createdAt.lt : before;
    }
    const q = f.q?.trim();
    return {
      businessId,
      ...(f.actorId ? { actorId: f.actorId } : {}),
      ...(f.resourceType ? { resourceType: f.resourceType } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
      ...(q
        ? {
            OR: [
              { resourceName: { contains: q, mode: "insensitive" as const } },
              { actorName: { contains: q, mode: "insensitive" as const } },
              { action: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
  }
}

function serialize(row: EventRow) {
  return {
    id: row.id,
    action: row.action,
    summary: summarize(row),
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    actor: row.actorId ? { id: row.actorId, name: row.actorName ?? "Unknown" } : null,
    details: row.details,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}
