import type { AppDefinition, AppField, AppWidget, AppWidgetResult } from "@platform/shared-types";
import { DAY_MS, fieldValue, inPeriod, localTime, matches, startOfToday, type EvalContext, type RecordLike } from "./filters";

const LIST_LIMIT = 6;

export interface DashboardInput {
  definition: AppDefinition;
  /** Records by entity key. */
  records: Record<string, RecordLike[]>;
  /** User id -> display name, for "user" fields. */
  members: Map<string, string>;
  ctx: EvalContext;
}

/** What a group is called: a member's name, a related record's title, or the value itself. */
export function displayValue(input: DashboardInput, field: AppField | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return field?.type === "user" ? "Unassigned" : "None";
  if (field?.type === "user") return input.members.get(String(value)) ?? "Former member";
  if (field?.type === "relation" && field.relation) {
    const entity = input.definition.entities.find((e) => e.key === field.relation);
    const related = input.records[field.relation]?.find((r) => r.id === value);
    return related && entity ? String(related.data[entity.titleField] ?? "Untitled") : "Removed";
  }
  return String(value);
}

function aggregate(widget: AppWidget, rows: RecordLike[], input: DashboardInput, completedAtField?: string): number {
  const numbers = () => rows.map((r) => Number(fieldValue(r, widget.field ?? "")) || 0);
  switch (widget.aggregate) {
    case "sum":
      return numbers().reduce((a, b) => a + b, 0);
    case "avg":
      return rows.length ? numbers().reduce((a, b) => a + b, 0) / rows.length : 0;
    case "duration": {
      // Average hours from creation to completion, for completed records.
      const hours = rows
        .map((r) => {
          const done = localTime(r.data[completedAtField ?? ""], input.ctx);
          const start = localTime(r.createdAt, input.ctx)!;
          return done !== undefined ? (done - start) / 3_600_000 : undefined;
        })
        .filter((h): h is number => h !== undefined && h >= 0);
      return hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : 0;
    }
    case "ratio":
      return rows.length ? (rows.filter((r) => matches(r, widget.ratioFilters, input.ctx)).length / rows.length) * 100 : 0;
    default:
      return rows.length;
  }
}

/** A widget's result; list widgets carry raw records, serialized by the service. */
export type WidgetOutput = Omit<AppWidgetResult, "records"> & { records?: RecordLike[] };

export function computeWidget(widget: AppWidget, input: DashboardInput): WidgetOutput {
  const entity = input.definition.entities.find((e) => e.key === widget.entity);
  if (!entity) return { key: widget.key, value: 0 };
  const dateField = widget.dateField ?? "createdAt";
  const all = input.records[widget.entity] ?? [];
  const filtered = all.filter((r) => matches(r, widget.filters, input.ctx));
  const rows = widget.type === "trend" ? filtered : filtered.filter((r) => inPeriod(r, dateField, widget.period, input.ctx));
  const fieldOf = (key?: string) => entity.fields.find((f) => f.key === key);

  switch (widget.type) {
    case "metric":
      return { key: widget.key, value: aggregate(widget, rows, input, entity.completedAtField) };

    case "bar":
    case "donut": {
      const groupField = fieldOf(widget.groupBy);
      const buckets = new Map<string, RecordLike[]>();
      // Select fields keep their option order (and show empty options on bars).
      if (groupField?.type === "select" && widget.type === "bar") for (const o of groupField.options ?? []) buckets.set(o.value, []);
      for (const r of rows) {
        const key = displayValue(input, groupField, fieldValue(r, widget.groupBy ?? ""));
        buckets.set(key, [...(buckets.get(key) ?? []), r]);
      }
      let groups = [...buckets.entries()].map(([label, items]) => ({
        label,
        value: aggregate(widget, items, input, entity.completedAtField),
        color: groupField?.options?.find((o) => o.value === label)?.color,
      }));
      if (groupField?.type !== "select" || widget.type === "donut") groups = groups.filter((g) => g.value > 0).sort((a, b) => b.value - a.value);
      return { key: widget.key, groups };
    }

    case "trend": {
      const unit = widget.trend?.unit ?? "day";
      const count = widget.trend?.count ?? 14;
      const today = startOfToday(input.ctx);
      const now = new Date(today);
      const buckets = Array.from({ length: count }, (_, i) => {
        const back = count - 1 - i;
        if (unit === "day") {
          const start = today - back * DAY_MS;
          return { start, end: start + DAY_MS, label: new Date(start).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) };
        }
        const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1);
        const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1);
        return { start, end, label: new Date(start).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) };
      });
      const points = buckets.map((b) => ({
        label: b.label,
        value: aggregate(
          widget,
          rows.filter((r) => {
            const t = localTime(fieldValue(r, dateField), input.ctx);
            return t !== undefined && t >= b.start && t < b.end;
          }),
          input,
          entity.completedAtField,
        ),
      }));
      return { key: widget.key, points };
    }

    case "progress": {
      // Spend per group against limits held in another entity (budgets per category).
      const target = widget.target;
      const limits = new Map<string, number>();
      for (const r of target ? (input.records[target.entity] ?? []) : []) {
        const key = String(r.data[target!.keyField] ?? "");
        if (key) limits.set(key, (limits.get(key) ?? 0) + (Number(r.data[target!.valueField]) || 0));
      }
      const spent = new Map<string, number>();
      for (const r of rows) {
        const key = String(fieldValue(r, widget.groupBy ?? "") ?? "");
        spent.set(key, (spent.get(key) ?? 0) + (Number(fieldValue(r, widget.field ?? "")) || 0));
      }
      const groupField = fieldOf(widget.groupBy);
      const groups = [...limits.keys()]
        .map((label) => ({ label, value: spent.get(label) ?? 0, target: limits.get(label), color: groupField?.options?.find((o) => o.value === label)?.color }))
        .sort((a, b) => b.value / (b.target || 1) - a.value / (a.target || 1));
      return { key: widget.key, groups };
    }

    case "list": {
      // Upcoming lists run soonest first; everything else newest first.
      const ascending = widget.period === "today" || widget.period === "next_7_days";
      const sorted = [...rows].sort((a, b) => {
        const ta = localTime(fieldValue(a, dateField), input.ctx) ?? 0;
        const tb = localTime(fieldValue(b, dateField), input.ctx) ?? 0;
        return ascending ? ta - tb : tb - ta;
      });
      return { key: widget.key, value: rows.length, records: sorted.slice(0, LIST_LIMIT) };
    }
  }
}
