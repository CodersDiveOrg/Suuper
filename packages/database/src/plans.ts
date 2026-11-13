import { PLANS, type PlanDefinition, type PlanGrantSummary, type UsageMeterKey } from "@platform/shared-types";
import { prisma } from "./client";

// Plans are rows in the Plan table, edited in the admin panel. Services read
// them often (every quota check), so they're cached briefly per process; an
// admin edit shows up within CACHE_MS everywhere.

export interface PlanRecord extends PlanDefinition {
  interval: "month" | "year";
  trialDays: number;
  isPublic: boolean;
  isDefault: boolean;
  archived: boolean;
  sortOrder: number;
  stripePriceId: string | null;
}

const CACHE_MS = 30_000;
let cache: { at: number; plans: PlanRecord[] } | null = null;

function fallback(): PlanRecord[] {
  return PLANS.map((p, i) => ({
    ...p, interval: "month", trialDays: 0, isPublic: true, isDefault: i === 0, archived: false, sortOrder: i + 1, stripePriceId: null,
  }));
}

/** Every plan, ordered for display (hidden and archived ones included). */
export async function allPlans(): Promise<PlanRecord[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.plans;
  try {
    const rows = await prisma.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { priceUsd: "asc" }] });
    const plans: PlanRecord[] = rows.length
      ? rows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          priceUsd: r.priceUsd,
          interval: r.interval === "year" ? "year" : "month",
          limits: r.limits as Record<UsageMeterKey, number>,
          trialDays: r.trialDays,
          isPublic: r.isPublic,
          isDefault: r.isDefault,
          archived: r.archived,
          sortOrder: r.sortOrder,
          stripePriceId: r.stripePriceId,
        }))
      : fallback();
    cache = { at: Date.now(), plans };
    return plans;
  } catch {
    // Table missing (migration not applied yet): keep working on the built-in plans.
    return fallback();
  }
}

/** Plans customers can pick on the billing page. */
export async function publicPlans(): Promise<PlanRecord[]> {
  return (await allPlans()).filter((p) => p.isPublic && !p.archived);
}

export async function defaultPlan(): Promise<PlanRecord> {
  const plans = await allPlans();
  return plans.find((p) => p.isDefault) ?? plans[0];
}

/** The plan with this key; an unknown key gets the default plan. */
export async function planByKey(key: string | null | undefined): Promise<PlanRecord> {
  const plans = await allPlans();
  return plans.find((p) => p.key === key) ?? (await defaultPlan());
}

export async function planExists(key: unknown): Promise<boolean> {
  return typeof key === "string" && (await allPlans()).some((p) => p.key === key);
}

export async function planByStripePrice(priceId: string | null | undefined): Promise<PlanRecord | null> {
  if (!priceId) return null;
  return (await allPlans()).find((p) => p.stripePriceId === priceId) ?? null;
}

/** Drops the cache, e.g. right after this process changed a plan. */
export function clearPlanCache() {
  cache = null;
}

// Stripe statuses where a subscription is still running; it decides the plan, not a grant.
const STRIPE_RUNNING = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

/**
 * Keeps Business.plan in step with the business's grants: ends grants past
 * their end date, switches to a grant once it has started (a queued renewal),
 * and drops to the default plan when nothing pays for one any more. Agency
 * clients and workspaces with a running Stripe subscription are left alone.
 * A few indexed reads when there's nothing to do.
 */
export async function expireGrants(businessId: string): Promise<void> {
  const now = new Date();
  const ended = await prisma.planGrant.updateMany({
    where: { businessId, endedAt: null, endsAt: { lte: now } },
    data: { endedAt: now, endReason: "expired" },
  });
  const active = await prisma.planGrant.findFirst({
    where: { businessId, endedAt: null, startsAt: { lte: now } },
    orderBy: { createdAt: "desc" },
    select: { planKey: true },
  });
  if (ended.count === 0 && !active) return;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { plan: true, agencyId: true, billingAccount: { select: { status: true } } },
  });
  if (!business || business.agencyId) return; // The agency sets its clients' plans.
  if (business.billingAccount?.status && STRIPE_RUNNING.includes(business.billingAccount.status)) return;
  const plan = active ? active.planKey : (await defaultPlan()).key;
  if (plan !== business.plan) await prisma.business.update({ where: { id: businessId }, data: { plan } });
}

/** The plan whose limits apply right now (ends expired grants first). */
export async function effectivePlan(businessId: string): Promise<PlanRecord> {
  await expireGrants(businessId);
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { plan: true } });
  return planByKey(business?.plan);
}

/** The running grant, for the billing page. */
export async function activeGrant(businessId: string): Promise<PlanGrantSummary | null> {
  const g = await prisma.planGrant.findFirst({
    where: { businessId, endedAt: null, startsAt: { lte: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!g) return null;
  return {
    kind: g.kind === "trial" || g.kind === "free" ? g.kind : "paid",
    planKey: g.planKey,
    startsAt: g.startsAt.toISOString(),
    ...(g.endsAt && { endsAt: g.endsAt.toISOString() }),
  };
}

/** Ends running grants when Stripe takes over billing (e.g. after checkout). */
export async function endGrants(businessId: string, reason: "stripe" | "replaced" | "revoked") {
  await prisma.planGrant.updateMany({ where: { businessId, endedAt: null }, data: { endedAt: new Date(), endReason: reason } });
}
