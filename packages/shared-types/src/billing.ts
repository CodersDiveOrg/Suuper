import type { PlanKey } from "./plans";

// Settings → Billing (GET /businesses/current/billing). Payments run through
// Stripe; without Stripe keys on the server, plan changes apply directly.

export interface BillingSubscription {
  /** Stripe status: trialing | active | past_due | unpaid | canceled | incomplete | incomplete_expired | paused */
  status: string;
  /** When the current period ends: the next charge, or the end date after cancelling. */
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  card?: { brand: string; last4: string };
}

export interface BillingInvoice {
  id: string;
  number?: string;
  createdAt: string;
  /** Smallest currency unit (cents). */
  amountDue: number;
  amountPaid: number;
  currency: string;
  /** draft | open | paid | uncollectible | void */
  status: string;
  hostedUrl?: string;
  pdfUrl?: string;
}

export interface BillingOverview {
  /** Stripe is set up on this server. When false, plan changes apply immediately without payment. */
  configured: boolean;
  plan: PlanKey;
  subscription: BillingSubscription | null;
  billingEmail?: string;
  /** Owners only (business:manage); empty for everyone else. */
  invoices: BillingInvoice[];
}

/** POST /billing/checkout: a Stripe Checkout URL for a first subscription, or the updated overview after a plan switch. */
export type BillingCheckoutResult = { url: string } | { overview: BillingOverview };
