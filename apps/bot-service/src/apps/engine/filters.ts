import type { AppFilter, AppPeriod } from "@platform/shared-types";

// Filters and periods run in the viewer's timezone: "today" and "this month"
// mean theirs, not the server's. Timestamps are shifted into that local frame
// and read with getUTC*; date-only values ("2026-10-22") are local midnights.

export interface RecordLike {
  id: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvalContext {
  userId?: string;
  now: Date;
  /** Minutes to add to UTC for local time, e.g. 300 for Pakistan (UTC+5). */
  tzOffsetMinutes: number;
}

const DAY_MS = 86_400_000;

/** A timestamp or date-only string as a point in the viewer's local frame. */
export function localTime(value: unknown, ctx: EvalContext): number | undefined {
  if (value instanceof Date) return value.getTime() + ctx.tzOffsetMinutes * 60_000;
  if (typeof value !== "string" || !value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00Z`);
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t + ctx.tzOffsetMinutes * 60_000;
}

export const startOfToday = (ctx: EvalContext) => Math.floor(localTime(ctx.now, ctx)! / DAY_MS) * DAY_MS;

/** A field's value; createdAt/updatedAt are the record's own. */
export function fieldValue(record: RecordLike, field: string): unknown {
  if (field === "createdAt") return record.createdAt;
  if (field === "updatedAt") return record.updatedAt;
  return record.data[field];
}

function resolve(value: AppFilter["value"], ctx: EvalContext): AppFilter["value"] {
  if (value === "$me") return ctx.userId ?? "";
  return value;
}

/** "$now", "$today" (start of today), "$endOfToday", "$monthStart", "$<field>" (another field of the record), or a date / timestamp. */
function timeOf(value: AppFilter["value"], ctx: EvalContext, record?: RecordLike): number | undefined {
  if (value === "$now") return localTime(ctx.now, ctx);
  if (value === "$today") return startOfToday(ctx);
  if (value === "$endOfToday") return startOfToday(ctx) + DAY_MS;
  if (value === "$monthStart") {
    const today = new Date(startOfToday(ctx));
    // "after" is strict, so a millisecond before the 1st.
    return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - 1;
  }
  if (typeof value === "string" && value.startsWith("$") && record) return localTime(fieldValue(record, value.slice(1)), ctx);
  return localTime(value, ctx);
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function matches(record: RecordLike, filters: AppFilter[] | undefined, ctx: EvalContext): boolean {
  if (!filters) return true;
  return filters.every((f) => {
    const actual = fieldValue(record, f.field);
    const expected = resolve(f.value, ctx);
    switch (f.op) {
      case "eq":
        return !isEmpty(actual) && String(actual) === String(expected);
      case "neq":
        return isEmpty(actual) || String(actual) !== String(expected);
      case "in":
        return Array.isArray(expected) && expected.includes(String(actual));
      case "nin":
        return !Array.isArray(expected) || !expected.includes(String(actual));
      case "empty":
        return isEmpty(actual);
      case "notEmpty":
        return !isEmpty(actual);
      case "gt":
        return Number(actual) > Number(expected);
      case "lt":
        return Number(actual) < Number(expected);
      case "before":
      case "after": {
        const a = localTime(actual, ctx);
        const b = timeOf(f.value, ctx, record);
        if (a === undefined || b === undefined) return false;
        return f.op === "before" ? a < b : a > b;
      }
      case "sameDay": {
        const a = localTime(actual, ctx);
        const day = timeOf(f.value ?? "$today", ctx);
        return a !== undefined && day !== undefined && Math.floor(a / DAY_MS) === Math.floor(day / DAY_MS);
      }
      default:
        return true;
    }
  });
}

/** [start, end) of a period in the local frame; undefined for "all". */
export function periodRange(period: AppPeriod | undefined, ctx: EvalContext): [number, number] | undefined {
  const today = startOfToday(ctx);
  const d = new Date(today);
  switch (period) {
    case "today":
      return [today, today + DAY_MS];
    case "this_week": {
      // Weeks start on Monday.
      const start = today - ((d.getUTCDay() + 6) % 7) * DAY_MS;
      return [start, start + 7 * DAY_MS];
    }
    case "this_month":
      return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
    case "last_30_days":
      return [today - 29 * DAY_MS, today + DAY_MS];
    case "next_7_days":
      return [localTime(ctx.now, ctx)!, today + 8 * DAY_MS];
    default:
      return undefined;
  }
}

export function inPeriod(record: RecordLike, dateField: string, period: AppPeriod | undefined, ctx: EvalContext): boolean {
  const range = periodRange(period, ctx);
  if (!range) return true;
  const t = localTime(fieldValue(record, dateField), ctx);
  return t !== undefined && t >= range[0] && t < range[1];
}

export { DAY_MS };
