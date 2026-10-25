import { BadRequestException } from "@nestjs/common";
import type { WorkflowTrigger } from "@platform/shared-types";

export type ScheduleTrigger = Extract<WorkflowTrigger, { type: "schedule" }>;

// Shortest interval allowed: workflows share one small server.
export const MINUTE_INTERVALS = [5, 10, 15, 30];

/** Cron pattern for a schedule trigger (validated by validateTrigger first). */
export function toCron(trigger: ScheduleTrigger): string {
  const [hour, minute] = (trigger.time ?? "09:00").split(":").map(Number);
  switch (trigger.frequency) {
    case "minutes":
      return `*/${trigger.intervalMinutes ?? 15} * * * *`;
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${trigger.dayOfWeek ?? 1}`;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Validates a schedule's timing fields (shared by workflow triggers and agent schedules). */
export function parseScheduleTrigger(t: Record<string, unknown>): ScheduleTrigger {
  const frequency = t.frequency;
  if (frequency !== "minutes" && frequency !== "hourly" && frequency !== "daily" && frequency !== "weekly") {
    throw new BadRequestException("Choose how often the schedule runs");
  }
  const timezone = typeof t.timezone === "string" && isValidTimezone(t.timezone) ? t.timezone : null;
  if (!timezone) throw new BadRequestException("Choose a valid timezone");
  const out: ScheduleTrigger = { type: "schedule", frequency, timezone };
  if (frequency === "minutes") {
    if (!MINUTE_INTERVALS.includes(Number(t.intervalMinutes))) {
      throw new BadRequestException(`Run every ${MINUTE_INTERVALS.join(", ")} minutes`);
    }
    out.intervalMinutes = Number(t.intervalMinutes);
  } else {
    if (typeof t.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)) throw new BadRequestException("Choose a time (HH:MM)");
    out.time = t.time;
  }
  if (frequency === "weekly") {
    const day = Number(t.dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new BadRequestException("Choose a day of the week");
    out.dayOfWeek = day;
  }
  return out;
}
