// --- Agencies and white-label ----------------------------------------------------
// An agency resells the platform under its own brand. Each of its clients is a
// normal business (Business.agencyId); the agency plan caps how many it has.
// Client businesses keep their own business plan (plans.ts) for usage limits,
// which the agency sets — they don't pay the platform directly.

import type { PlanKey } from "./plans";

export type AgencyPlanKey = "agency_starter" | "agency_growth" | "agency_scale";
export type AgencyRole = "owner" | "admin";

export interface AgencyPlanDefinition {
  key: AgencyPlanKey;
  name: string;
  priceUsd: number;
  description: string;
  /** Client businesses the agency can have. */
  clients: number;
  /** Business plans the agency can put its clients on. */
  clientPlans: PlanKey[];
  /** Custom domain and branded email (the brand name, logo and colour work on every plan). */
  customDomain: boolean;
}

export const AGENCY_PLANS: AgencyPlanDefinition[] = [
  {
    key: "agency_starter",
    name: "Agency Starter",
    priceUsd: 97,
    description: "Try reselling with your first few clients.",
    clients: 5,
    clientPlans: ["starter"],
    customDomain: false,
  },
  {
    key: "agency_growth",
    name: "Agency Growth",
    priceUsd: 297,
    description: "Your own domain and branded emails for a growing client list.",
    clients: 20,
    clientPlans: ["starter", "growth"],
    customDomain: true,
  },
  {
    key: "agency_scale",
    name: "Agency Scale",
    priceUsd: 497,
    description: "Many clients, every plan, fully white-labelled.",
    clients: 60,
    clientPlans: ["starter", "growth", "pro"],
    customDomain: true,
  },
];

export function isAgencyPlanKey(value: unknown): value is AgencyPlanKey {
  return AGENCY_PLANS.some((plan) => plan.key === value);
}

export function agencyPlanFor(key: string | null | undefined): AgencyPlanDefinition {
  return AGENCY_PLANS.find((plan) => plan.key === key) ?? AGENCY_PLANS[0];
}

/** What the web app and emails show instead of the platform's own name and colours. */
export interface Brand {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  hidePoweredBy: boolean;
  /** Null for the platform's own brand. */
  agencyId: string | null;
}

export interface AgencySummary {
  id: string;
  name: string;
  slug: string;
  role: AgencyRole;
  plan: AgencyPlanKey;
  clientCount: number;
}

export interface AgencyDomain {
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  /** DNS records to add: CNAME the domain to the platform, TXT to prove ownership. */
  records: { type: "CNAME" | "TXT"; name: string; value: string }[];
}

export interface AgencyDetail extends AgencySummary {
  brandName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  hidePoweredBy: boolean;
  emailFromName: string | null;
  emailReplyTo: string | null;
  domain: AgencyDomain | null;
  limits: { clients: number; clientPlans: PlanKey[]; customDomain: boolean };
  /** False when payments are on: the plan is then changed through billing. */
  canChangePlanDirectly: boolean;
  createdAt: string;
}

export interface AgencyClient {
  id: string;
  name: string;
  slug: string;
  plan: PlanKey;
  memberCount: number;
  botCount: number;
  appCount: number;
  /** Bot replies this month. */
  repliesThisMonth: number;
  /** Pending owner invitation, if one was sent when the client was added. */
  pendingOwnerEmail: string | null;
  createdAt: string;
}

export interface AgencyMemberRow {
  userId: string;
  name: string | null;
  email: string;
  role: AgencyRole;
  createdAt: string;
}
