// --- Plans and usage meters -------------------------------------------------------
// Each business is on one plan (Business.plan). Monthly meters reset on the 1st
// (UTC); total meters count what exists right now. Limits are enforced where
// the thing is used or created (see bot-service usage/quota.ts).

export type PlanKey = "starter" | "growth" | "pro";

export type UsageMeterKey =
  | "ai_replies"
  | "ai_credits"
  | "agent_runs"
  | "workflow_runs"
  | "bots"
  | "members"
  | "knowledge_storage"
  | "app_records";

export interface UsageMeterDefinition {
  key: UsageMeterKey;
  label: string;
  /** Used mid-sentence in limit messages ("all 2,000 bot replies"). */
  noun: string;
  description: string;
  /** "month": resets on the 1st (UTC). "total": what exists now. */
  period: "month" | "total";
  unit: "count" | "credits" | "bytes";
}

export const USAGE_METERS: UsageMeterDefinition[] = [
  { key: "ai_replies", label: "Bot replies", noun: "bot replies", description: "Answers your bots send, on your website, in the playground and on other channels.", period: "month", unit: "count" },
  { key: "ai_credits", label: "AI credits", noun: "AI credits", description: "AI work across bots, agents, workflows and apps. Bigger models use more credits; local models and your own provider keys use none.", period: "month", unit: "credits" },
  { key: "agent_runs", label: "Agent runs", noun: "agent runs", description: "Requests agents work on, from chat and schedules.", period: "month", unit: "count" },
  { key: "workflow_runs", label: "Workflow runs", noun: "workflow runs", description: "Times a workflow ran, from any trigger.", period: "month", unit: "count" },
  { key: "bots", label: "Bots", noun: "bots", description: "Bots in this workspace.", period: "total", unit: "count" },
  { key: "members", label: "Team seats", noun: "team seats", description: "Members plus pending invitations.", period: "total", unit: "count" },
  { key: "knowledge_storage", label: "Knowledge storage", noun: "knowledge storage", description: "Documents, website pages, products and their search index.", period: "total", unit: "bytes" },
  { key: "app_records", label: "App records", noun: "app records", description: "Records across all apps, including form submissions.", period: "total", unit: "count" },
];

// AI credits: 1 credit = $0.01 of what the model provider charges (list prices,
// see bot-service models.ts). Plans include a monthly budget; expensive models
// simply use it faster. Calls on the business's own key or a local model are free.
export const CREDITS_PER_USD = 100;

export function creditsForCost(costUsd: number): number {
  return costUsd * CREDITS_PER_USD;
}

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  priceUsd: number;
  description: string;
  limits: Record<UsageMeterKey, number>;
}

const MB = 1024 * 1024;

export const PLANS: PlanDefinition[] = [
  {
    key: "starter",
    name: "Starter",
    priceUsd: 97,
    description: "One location getting started with an AI assistant.",
    limits: {
      ai_replies: 2_000,
      ai_credits: 1_500,
      agent_runs: 300,
      workflow_runs: 2_000,
      bots: 3,
      members: 3,
      knowledge_storage: 100 * MB,
      app_records: 10_000,
    },
  },
  {
    key: "growth",
    name: "Growth",
    priceUsd: 297,
    description: "A growing business with steady customer traffic.",
    limits: {
      ai_replies: 10_000,
      ai_credits: 6_000,
      agent_runs: 1_500,
      workflow_runs: 10_000,
      bots: 10,
      members: 10,
      knowledge_storage: 500 * MB,
      app_records: 50_000,
    },
  },
  {
    key: "pro",
    name: "Pro",
    priceUsd: 497,
    description: "High volume, several teams or locations.",
    limits: {
      ai_replies: 50_000,
      ai_credits: 15_000,
      agent_runs: 5_000,
      workflow_runs: 50_000,
      bots: 25,
      members: 25,
      knowledge_storage: 2048 * MB,
      app_records: 250_000,
    },
  },
];

export function isPlanKey(value: unknown): value is PlanKey {
  return PLANS.some((p) => p.key === value);
}

/** The business's plan; an unknown key falls back to Starter. */
export function planFor(key: string | null | undefined): PlanDefinition {
  return PLANS.find((p) => p.key === key) ?? PLANS[0];
}

export function meterDefinition(key: UsageMeterKey): UsageMeterDefinition {
  return USAGE_METERS.find((m) => m.key === key)!;
}

/** First instant of the month containing `date`, and of the next month (UTC). */
export function monthBounds(date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

/** "You've used all 2,000 bot replies on the Starter plan this month…" */
export function limitMessage(meter: UsageMeterKey, plan: PlanDefinition): string {
  const def = meterDefinition(meter);
  const limit = plan.limits[meter];
  const amount = def.unit === "bytes" ? `${Math.round(limit / MB).toLocaleString("en-US")} MB of` : limit.toLocaleString("en-US");
  return def.period === "month"
    ? `This workspace has used all ${amount} ${def.noun} included in the ${plan.name} plan this month. Upgrade the plan or wait for the limit to reset on the 1st.`
    : `This workspace has reached the ${plan.name} plan's limit of ${amount} ${def.noun}. Upgrade the plan or remove some first.`;
}

/** Body of the 402 every service returns when a plan limit is reached. */
export function quotaExceededBody(meter: UsageMeterKey, plan: PlanDefinition) {
  return { statusCode: 402, error: "Payment Required", code: "quota_exceeded" as const, meter, message: limitMessage(meter, plan) };
}

/** Usage page response (bot-service usage module). */
export interface UsageMeterValue extends UsageMeterDefinition {
  used: number;
  limit: number;
}

export type UsageFeature = "bot" | "agent" | "workflow" | "app";

export interface UsageSummary {
  plan: Omit<PlanDefinition, "limits">;
  period: { start: string; end: string; current: boolean };
  meters: UsageMeterValue[];
  /** One entry per UTC day of the period (up to today for the current month). */
  daily: {
    date: string;
    tokens: Record<UsageFeature, number>;
    /** AI credits used, by feature. */
    credits: Record<UsageFeature, number>;
    replies: number;
    agentRuns: number;
    workflowRuns: number;
  }[];
  byFeature: { feature: UsageFeature; calls: number; inputTokens: number; outputTokens: number; credits: number }[];
  /** `ownKey`: ran on the business's own provider key (0 credits). */
  byModel: { model: string; provider: string; ownKey: boolean; calls: number; inputTokens: number; outputTokens: number; credits: number }[];
}
