import Stripe from "stripe";
import type { PlanKey } from "@platform/shared-types";

// Stripe is optional: without these env vars, billing runs in "not configured"
// mode and owners change plans directly (Usage page / PATCH usage/plan).
const PRICE_ENV: Record<PlanKey, string> = {
  starter: "STRIPE_PRICE_STARTER",
  growth: "STRIPE_PRICE_GROWTH",
  pro: "STRIPE_PRICE_PRO",
};

let client: Stripe | null = null;

export function billingConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY && Object.values(PRICE_ENV).every((name) => !!process.env[name]);
}

export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
  return client;
}

export function priceFor(plan: PlanKey): string {
  return process.env[PRICE_ENV[plan]] ?? "";
}

/** The plan a Stripe price belongs to, or null for a price we don't sell. */
export function planForPrice(priceId: string | undefined): PlanKey | null {
  if (!priceId) return null;
  const entry = (Object.entries(PRICE_ENV) as [PlanKey, string][]).find(([, name]) => process.env[name] === priceId);
  return entry?.[0] ?? null;
}
