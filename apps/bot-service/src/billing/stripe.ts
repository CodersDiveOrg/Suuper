import Stripe from "stripe";
import { planByKey, planByStripePrice, type PlanRecord } from "@platform/database";

// Stripe is optional. Without STRIPE_SECRET_KEY, billing runs in "not configured"
// mode: the Suuper team grants plans from the admin panel and customers can't
// change plans themselves. Each plan's Stripe price is set on the plan in the
// admin panel; the old STRIPE_PRICE_<KEY> env vars still work as a fallback.

let client: Stripe | null = null;

export function billingConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
  return client;
}

/** The Stripe price for a plan, or "" when the plan can't be bought through Stripe yet. */
export function priceFor(plan: PlanRecord): string {
  return plan.stripePriceId ?? process.env[`STRIPE_PRICE_${plan.key.toUpperCase()}`] ?? "";
}

/** The plan a Stripe price belongs to, or null for a price we don't sell. */
export async function planForPrice(priceId: string | undefined): Promise<PlanRecord | null> {
  if (!priceId) return null;
  const byColumn = await planByStripePrice(priceId);
  if (byColumn) return byColumn;
  const envMatch = Object.entries(process.env).find(([name, value]) => name.startsWith("STRIPE_PRICE_") && value === priceId);
  return envMatch ? planByKey(envMatch[0].slice("STRIPE_PRICE_".length).toLowerCase()) : null;
}
