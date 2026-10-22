import type { WorkflowTrigger } from "@platform/shared-types";

type ScheduleTrigger = Extract<WorkflowTrigger, { type: "schedule" }>;

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
