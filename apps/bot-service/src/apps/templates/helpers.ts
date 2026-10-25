import type { AppField, AppFieldOption } from "@platform/shared-types";
import type { Answers, AppTemplate } from "./types";

// Colours for options: badges, board columns and chart slices.
export const C = {
  gray: "#94A3B8",
  blue: "#3B82F6",
  sky: "#0EA5E9",
  violet: "#8B5CF6",
  amber: "#F59E0B",
  orange: "#F97316",
  green: "#10B981",
  teal: "#14B8A6",
  red: "#EF4444",
  pink: "#EC4899",
  slate: "#475569",
};
const CYCLE = [C.blue, C.violet, C.teal, C.amber, C.pink, C.sky, C.orange, C.green, C.red, C.slate];

/** Options with given colours, or colours from the cycle. */
export function options(values: string[], colors?: string[]): AppFieldOption[] {
  return values.map((value, i) => ({ value, color: colors?.[i] ?? CYCLE[i % CYCLE.length] }));
}

/** "Travel, Food\nRent" -> ["Travel", "Food", "Rent"]; the fallback when blank. */
export function list(answer: string | undefined, fallback: string[]): string[] {
  const items = (answer ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)].slice(0, 30) : fallback;
}

export const currencyOf = (answers: Answers) => answers.currency?.trim().toUpperCase().slice(0, 5) || "PKR";

export const field = (key: string, label: string, type: AppField["type"], extra: Partial<AppField> = {}): AppField => ({ key, label, type, ...extra });

/** The definition a template produces with its default answers (for the store preview). */
export function defaultAnswers(template: AppTemplate): Answers {
  return Object.fromEntries(template.setupQuestions.map((q) => [q.key, q.default ?? ""]));
}

/** A small deterministic random generator, so sample data looks varied but is the same every install. */
export function seeded(seed: number) {
  let s = seed;
  const next = () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  return {
    next,
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
  };
}

// Sample dates are laid out in the business's local day (Pakistan, UTC+5, by default), so
// "today's" samples are today for the people looking at them, even around midnight.
const SAMPLE_TZ_HOURS = 5;

/** "2026-10-22": the local date `days` from `now` (negative = past). */
export function dateFrom(now: Date, days: number, tzOffsetHours = SAMPLE_TZ_HOURS): string {
  return new Date(now.getTime() + tzOffsetHours * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

/** An ISO time at a local hour on the local date `days` from `now`. */
export function timeFrom(now: Date, days: number, hour: number, minute = 0, tzOffsetHours = SAMPLE_TZ_HOURS): string {
  const [y, m, d] = dateFrom(now, days, tzOffsetHours).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - tzOffsetHours * 3_600_000).toISOString();
}
