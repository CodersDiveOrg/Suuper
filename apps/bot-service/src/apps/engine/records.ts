import { BadRequestException } from "@nestjs/common";
import type { AppEntity, AppField } from "@platform/shared-types";

const MAX_TEXT = 200;
const MAX_LONG_TEXT = 10_000;

export interface ValidationContext {
  /** Member ids, for "user" fields. */
  memberIds: Set<string>;
  /** Whether a record id exists in an entity, for "relation" fields. */
  relationExists: (entity: string, id: string) => Promise<boolean>;
}

/** One value checked and normalised for its field; null clears the field. */
async function cleanValue(field: AppField, raw: unknown, ctx: ValidationContext): Promise<unknown> {
  if (raw === null || raw === undefined || raw === "") return null;
  const label = `“${field.label}”`;
  const text = (max: number) => {
    if (typeof raw !== "string" && typeof raw !== "number") throw new BadRequestException(`${label} must be text`);
    const value = String(raw).trim();
    if (value.length > max) throw new BadRequestException(`${label} is too long`);
    return value || null;
  };
  switch (field.type) {
    case "text":
      return text(MAX_TEXT);
    case "textarea":
      return text(MAX_LONG_TEXT);
    case "email": {
      const value = text(MAX_TEXT);
      if (value && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) throw new BadRequestException(`${label} must be a valid email address`);
      return value;
    }
    case "phone": {
      const value = text(30);
      if (value && !/^[+\d][\d\s()-]{6,24}$/.test(value)) throw new BadRequestException(`${label} must be a valid phone number`);
      return value;
    }
    case "url": {
      const value = text(1000);
      if (value && !/^https?:\/\/\S+$/i.test(value)) throw new BadRequestException(`${label} must be a link starting with http:// or https://`);
      return value;
    }
    case "number":
    case "currency": {
      const value = Number(typeof raw === "string" ? raw.replace(/,/g, "") : raw);
      if (!Number.isFinite(value)) throw new BadRequestException(`${label} must be a number`);
      return field.type === "currency" ? Math.round(value * 100) / 100 : value;
    }
    case "date": {
      const value = text(10);
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label} must be a date`);
      return value;
    }
    case "datetime": {
      const t = Date.parse(String(raw));
      if (Number.isNaN(t)) throw new BadRequestException(`${label} must be a date and time`);
      return new Date(t).toISOString();
    }
    case "checkbox":
      return raw === true || raw === "true" || raw === "on";
    case "select": {
      const value = text(MAX_TEXT);
      if (value && !field.options?.some((o) => o.value === value)) throw new BadRequestException(`Choose one of the options for ${label}`);
      return value;
    }
    case "user": {
      const value = text(64);
      if (value && !ctx.memberIds.has(value)) throw new BadRequestException(`${label} must be a member of this business`);
      return value;
    }
    case "relation": {
      const value = text(64);
      if (value && !(field.relation && (await ctx.relationExists(field.relation, value)))) throw new BadRequestException(`${label} wasn't found`);
      return value;
    }
  }
}

/**
 * Input for a new record or a change, checked against the entity's fields.
 * `partial`: only the given fields (an edit); otherwise required fields must be
 * filled. Read-only fields are skipped unless `allowReadOnly` (the app's own updates).
 */
export async function cleanRecordData(
  entity: AppEntity,
  input: unknown,
  ctx: ValidationContext,
  options: { partial: boolean; onlyFields?: string[] },
): Promise<Record<string, unknown>> {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const result: Record<string, unknown> = {};
  for (const field of entity.fields) {
    if (field.readOnly) continue;
    if (options.onlyFields && !options.onlyFields.includes(field.key)) continue;
    if (options.partial && !(field.key in raw)) continue;
    const value = await cleanValue(field, raw[field.key], ctx);
    if (value === null && field.required && !options.partial && !field.copyFrom) throw new BadRequestException(`Please fill in “${field.label}”`);
    if (value === null && field.required && options.partial) throw new BadRequestException(`“${field.label}” can't be empty`);
    result[field.key] = value;
  }
  return result;
}

/** Drops cleared (null) values so stored records stay compact. */
export function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

/**
 * Values the app fills in itself on create: the first status, SLA due dates,
 * values copied from a related record, and the completion time.
 */
export async function applyCreateRules(
  entity: AppEntity,
  data: Record<string, unknown>,
  now: Date,
  related: (entity: string, id: string) => Promise<Record<string, unknown> | undefined>,
) {
  const status = entity.fields.find((f) => f.key === entity.statusField);
  if (status && !data[status.key]) data[status.key] = status.options?.[0]?.value;
  if (entity.sla && !data[entity.sla.dueField]) {
    const hours = entity.sla.hours[String(data[entity.sla.field] ?? "")];
    if (hours) data[entity.sla.dueField] = new Date(now.getTime() + hours * 3_600_000).toISOString();
  }
  for (const field of entity.fields) {
    if (!field.copyFrom || data[field.key] !== undefined) continue;
    const relationField = entity.fields.find((f) => f.key === field.copyFrom!.relationField);
    const id = data[field.copyFrom.relationField];
    if (relationField?.relation && typeof id === "string") {
      const value = (await related(relationField.relation, id))?.[field.copyFrom.field];
      if (value !== undefined) data[field.key] = value;
    }
  }
  applyStatusRules(entity, undefined, data, now);
}

/** Stamps (or clears) the completion time when the status moves into (or out of) a done status. */
export function applyStatusRules(entity: AppEntity, before: Record<string, unknown> | undefined, after: Record<string, unknown>, now: Date) {
  if (!entity.statusField || !entity.completedAtField) return;
  const done = new Set(entity.doneStatuses ?? []);
  const wasDone = before ? done.has(String(before[entity.statusField])) : false;
  const isDone = done.has(String(after[entity.statusField]));
  if (isDone && !wasDone) after[entity.completedAtField] = now.toISOString();
  if (!isDone && wasDone) after[entity.completedAtField] = null;
}
