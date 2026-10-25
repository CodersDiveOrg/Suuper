import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import type { AppDefinition, AppEntity, AppMember, AppRecord, AppRecordActivity } from "@platform/shared-types";
import { WorkflowsService } from "../workflows/workflows.service";
import { emitWebhookEvent } from "../webhooks/delivery";
import { localTime, matches, type EvalContext } from "./engine/filters";
import { applyCreateRules, applyStatusRules, cleanRecordData, compact } from "./engine/records";
import { assertWithinQuota } from "../usage/quota";

const config = loadServiceConfig("bot-service", 3002);

const MAX_LIST = 2000;
const MAX_COMMENT = 5000;

export type AppRow = NonNullable<Awaited<ReturnType<typeof prisma.app.findUnique>>>;
type RecordRow = NonNullable<Awaited<ReturnType<typeof prisma.appRecord.findUnique>>>;

/** Who's acting: a member (id + name), or the public form / the app itself (no id). */
export interface Actor {
  id?: string;
  name: string;
}

export const definitionOf = (app: AppRow) => app.definition as unknown as AppDefinition;

export function entityOf(app: AppRow, key: string): AppEntity {
  const entity = definitionOf(app).entities.find((e) => e.key === key);
  if (!entity) throw new NotFoundException(`This app has no “${key}” records`);
  return entity;
}

export function serializeRecord(app: AppRow, row: RecordRow): AppRecord {
  const prefix = definitionOf(app).entities.find((e) => e.key === row.entity)?.numberPrefix ?? "#";
  return {
    id: row.id,
    appId: row.appId,
    entity: row.entity,
    number: row.number,
    reference: `${prefix}${row.number}`,
    data: row.data as Record<string, unknown>,
    source: row.source as AppRecord["source"],
    createdById: row.createdById ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const asRecordLike = (row: RecordRow) => ({ id: row.id, data: row.data as Record<string, unknown>, createdAt: row.createdAt, updatedAt: row.updatedAt });

@Injectable()
export class RecordsService {
  constructor(private readonly workflows: WorkflowsService) {}

  async members(businessId: string): Promise<AppMember[]> {
    const memberships = await prisma.membership.findMany({ where: { businessId }, include: { user: { select: { id: true, name: true, email: true } } } });
    return memberships.map((m) => ({ id: m.user.id, name: m.user.name || m.user.email.split("@")[0], email: m.user.email })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async actor(businessId: string, userId: string): Promise<Actor> {
    return { id: userId, name: (await this.members(businessId)).find((m) => m.id === userId)?.name ?? "Someone" };
  }

  /** An entity's records, optionally through a view (its filters and sort) and a text search. */
  async list(app: AppRow, entityKey: string, options: { viewKey?: string; q?: string; ctx: EvalContext }): Promise<AppRecord[]> {
    const definition = definitionOf(app);
    const view = options.viewKey ? definition.views.find((v) => v.key === options.viewKey) : undefined;
    const entity = entityOf(app, view?.entity ?? entityKey);
    const rows = await prisma.appRecord.findMany({ where: { appId: app.id, entity: entity.key }, orderBy: { createdAt: "desc" }, take: MAX_LIST });
    let result = rows.filter((row) => matches(asRecordLike(row), view?.filters, options.ctx));
    const q = options.q?.trim().toLowerCase();
    if (q) {
      result = result.filter((row) => `${entity.numberPrefix}${row.number} ${Object.values(row.data as object).join(" ")}`.toLowerCase().includes(q));
    }
    if (view?.sort) {
      const { field, dir } = view.sort;
      const key = (row: RecordRow) => {
        const value = field === "createdAt" ? row.createdAt : (row.data as Record<string, unknown>)[field];
        return typeof value === "number" ? value : (localTime(value, options.ctx) ?? (value === undefined ? undefined : String(value)));
      };
      result.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        // Blanks go last either way.
        if (ka === undefined) return kb === undefined ? 0 : 1;
        if (kb === undefined) return -1;
        const order = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
        return dir === "asc" ? order : -order;
      });
    }
    return result.map((row) => serializeRecord(app, row));
  }

  async require(app: AppRow, recordId: string): Promise<RecordRow> {
    const row = await prisma.appRecord.findUnique({ where: { id: recordId } });
    if (!row || row.appId !== app.id) throw new NotFoundException("Record not found");
    return row;
  }

  /**
   * A new record: validated against its fields, with the app's own values filled
   * in (first status, SLA due time, copied prices), numbered, logged and passed
   * to matching automations. `onlyFields` limits input to a public form's fields.
   */
  async create(
    app: AppRow,
    entityKey: string,
    input: unknown,
    actor: Actor,
    options: { source?: "app" | "public"; onlyFields?: string[]; defaults?: Record<string, unknown> } = {},
  ): Promise<AppRecord> {
    const entity = entityOf(app, entityKey);
    await assertWithinQuota(app.businessId, ["app_records"]);
    const data = await cleanRecordData(entity, input, await this.validation(app), { partial: false, onlyFields: options.onlyFields });
    for (const [key, value] of Object.entries(options.defaults ?? {})) if (data[key] === null || data[key] === undefined) data[key] = value;
    // A public form only asks for some fields; the rest must still be valid when they're required.
    if (options.onlyFields) {
      for (const f of entity.fields) {
        if (f.required && !f.readOnly && !f.copyFrom && (data[f.key] === null || data[f.key] === undefined) && f.key !== entity.statusField && f.key !== entity.sla?.dueField) {
          throw new BadRequestException(`Please fill in “${f.label}”`);
        }
      }
    }
    const now = new Date();
    await applyCreateRules(entity, data, now, (relEntity, id) => this.relatedData(app, relEntity, id));
    const row = await this.insert(app, entity.key, compact(data), { source: options.source ?? "app", createdById: actor.id });
    await prisma.appRecordActivity.create({ data: { recordId: row.id, type: "created", actorId: actor.id, actorName: actor.name, detail: {} } });
    await this.runAutomations(app, entity, row, undefined);
    this.emitRecordEvent(app, entity, row, "app.record.created");
    return serializeRecord(app, row);
  }

  /** Inserts with the next number for the entity; retries if two inserts race for the same number. */
  async insert(app: AppRow, entity: string, data: Record<string, unknown>, extra: { source: string; createdById?: string; createdAt?: Date }) {
    for (let attempt = 0; ; attempt++) {
      const last = await prisma.appRecord.findFirst({ where: { appId: app.id, entity }, orderBy: { number: "desc" }, select: { number: true } });
      try {
        return await prisma.appRecord.create({
          data: {
            businessId: app.businessId,
            appId: app.id,
            entity,
            number: (last?.number ?? 1000) + 1,
            data: data as object,
            source: extra.source,
            createdById: extra.createdById,
            ...(extra.createdAt ? { createdAt: extra.createdAt, updatedAt: extra.createdAt } : {}),
          },
        });
      } catch (error) {
        if (attempt >= 3 || (error as { code?: string }).code !== "P2002") throw error;
      }
    }
  }

  async update(app: AppRow, recordId: string, input: unknown, actor: Actor): Promise<AppRecord> {
    const row = await this.require(app, recordId);
    const entity = entityOf(app, row.entity);
    const before = row.data as Record<string, unknown>;
    const patch = await cleanRecordData(entity, input, await this.validation(app), { partial: true });
    const after: Record<string, unknown> = { ...before, ...patch };
    applyStatusRules(entity, before, after, new Date());
    const next = compact(after);
    const changes = [...new Set([...Object.keys(before), ...Object.keys(next)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
      .map((key) => ({ field: key, from: before[key] ?? null, to: next[key] ?? null }));
    if (changes.length === 0) return serializeRecord(app, row);

    const updated = await prisma.appRecord.update({ where: { id: row.id }, data: { data: next as object } });
    await prisma.appRecordActivity.create({ data: { recordId: row.id, type: "updated", actorId: actor.id, actorName: actor.name, detail: { changes } as object } });
    await this.runAutomations(app, entity, updated, before);
    this.emitRecordEvent(app, entity, updated, "app.record.updated", { changes });
    return serializeRecord(app, updated);
  }

  async remove(app: AppRow, recordId: string) {
    const row = await this.require(app, recordId);
    await prisma.appRecord.delete({ where: { id: recordId } });
    const entity = definitionOf(app).entities.find((e) => e.key === row.entity);
    emitWebhookEvent(app.businessId, "app.record.deleted", {
      app: { id: app.id, name: app.name },
      record: { id: row.id, reference: serializeRecord(app, row).reference, entity: { key: row.entity, name: entity?.name ?? row.entity } },
    });
  }

  async activity(app: AppRow, recordId: string): Promise<AppRecordActivity[]> {
    await this.require(app, recordId);
    const rows = await prisma.appRecordActivity.findMany({ where: { recordId }, orderBy: { createdAt: "asc" }, take: 500 });
    return rows.map((a) => ({
      id: a.id,
      type: a.type as AppRecordActivity["type"],
      actorName: a.actorName,
      detail: a.detail as AppRecordActivity["detail"],
      createdAt: a.createdAt.toISOString(),
    }));
  }

  async comment(app: AppRow, recordId: string, text: unknown, actor: Actor) {
    await this.require(app, recordId);
    if (typeof text !== "string" || !text.trim()) throw new BadRequestException("Write a comment first");
    await prisma.appRecordActivity.create({
      data: { recordId, type: "comment", actorId: actor.id, actorName: actor.name, detail: { text: text.trim().slice(0, MAX_COMMENT) } },
    });
    await prisma.appRecord.update({ where: { id: recordId }, data: { updatedAt: new Date() } });
    return this.activity(app, recordId);
  }

  /** A record's values made readable: member names and related records' titles instead of ids. */
  async readable(app: AppRow, entity: AppEntity, data: Record<string, unknown>, members?: AppMember[]): Promise<Record<string, unknown>> {
    const people = members ?? (await this.members(app.businessId));
    const result: Record<string, unknown> = {};
    for (const field of entity.fields) {
      const value = data[field.key];
      if (value === undefined) continue;
      if (field.type === "user") result[field.key] = people.find((m) => m.id === value)?.name ?? value;
      else if (field.type === "relation" && field.relation) {
        const relEntity = definitionOf(app).entities.find((e) => e.key === field.relation);
        const related = await this.relatedData(app, field.relation, String(value));
        result[field.key] = related && relEntity ? (related[relEntity.titleField] ?? value) : value;
      } else result[field.key] = value;
    }
    return result;
  }

  // --- helpers ------------------------------------------------------------------

  private async validation(app: AppRow) {
    return {
      memberIds: new Set((await this.members(app.businessId)).map((m) => m.id)),
      relationExists: async (entity: string, id: string) => Boolean(await this.relatedData(app, entity, id)),
    };
  }

  private async relatedData(app: AppRow, entity: string, id: string): Promise<Record<string, unknown> | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const row = await prisma.appRecord.findUnique({ where: { id } });
    return row && row.appId === app.id && row.entity === entity ? (row.data as Record<string, unknown>) : undefined;
  }

  /** Webhook payload: raw values (ids) in `data`, member names and related titles in `display`. */
  private emitRecordEvent(app: AppRow, entity: AppEntity, row: RecordRow, type: string, extra: Record<string, unknown> = {}) {
    emitWebhookEvent(app.businessId, type, async () => {
      const record = serializeRecord(app, row);
      return {
        app: { id: app.id, name: app.name },
        record: {
          id: record.id,
          reference: record.reference,
          entity: { key: entity.key, name: entity.name },
          source: record.source,
          data: record.data,
          display: await this.readable(app, entity, record.data),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          link: `${config.webAppUrl}/dashboard/apps/${app.id}?record=${row.id}`,
        },
        ...extra,
      };
    });
  }

  /** Runs the workflows of enabled automations whose trigger and conditions match. Failures never block the save. */
  private async runAutomations(app: AppRow, entity: AppEntity, row: RecordRow, before: Record<string, unknown> | undefined) {
    const after = row.data as Record<string, unknown>;
    const due = definitionOf(app).automations.filter((a) => {
      if (!a.enabled || !a.workflowId || a.trigger.entity !== entity.key) return false;
      if (a.trigger.type === "created" && before) return false;
      if (a.trigger.type === "changed") {
        if (!before || !a.trigger.field || JSON.stringify(before[a.trigger.field]) === JSON.stringify(after[a.trigger.field])) return false;
        if (a.trigger.to !== undefined && String(after[a.trigger.field]) !== a.trigger.to) return false;
      }
      return matches(asRecordLike(row), a.conditions, { now: new Date(), tzOffsetMinutes: 0 });
    });
    if (due.length === 0) return;
    const record = serializeRecord(app, row);
    const triggerData = {
      app: app.name,
      entity: entity.name,
      reference: record.reference,
      link: `${config.webAppUrl}/dashboard/apps/${app.id}?record=${row.id}`,
      ...(await this.readable(app, entity, after)),
    };
    for (const automation of due) {
      await this.workflows
        .runFromApp(app.businessId, automation.workflowId!, { ...triggerData, automation: automation.name })
        .catch((error) => console.warn(`[bot-service] app ${app.id} automation ${automation.key} failed to start: ${(error as Error).message}`));
    }
  }
}
