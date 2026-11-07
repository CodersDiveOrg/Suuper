import { prisma } from "./client";

// White-label brand resolution, shared by identity-service (web app, emails)
// and bot-service (public app pages, widget). Matches shared-types Brand.

export interface ResolvedBrand {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  hidePoweredBy: boolean;
  agencyId: string | null;
  /** Verified custom domain, for links in emails ("https://<domain>"). */
  customDomain: string | null;
  emailFromName: string | null;
  emailReplyTo: string | null;
}

export const PLATFORM_NAME = process.env.APP_NAME || "Suuper";

type AgencyBrandRow = {
  id: string;
  name: string;
  brandName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  hidePoweredBy: boolean;
  customDomain: string | null;
  domainVerifiedAt: Date | null;
  emailFromName: string | null;
  emailReplyTo: string | null;
};

export function platformBrand(): ResolvedBrand {
  return {
    name: PLATFORM_NAME,
    logoUrl: null,
    primaryColor: null,
    supportEmail: null,
    hidePoweredBy: false,
    agencyId: null,
    customDomain: null,
    emailFromName: null,
    emailReplyTo: null,
  };
}

export function brandOfAgency(agency: AgencyBrandRow | null | undefined): ResolvedBrand {
  if (!agency) return platformBrand();
  return {
    name: agency.brandName?.trim() || agency.name,
    logoUrl: agency.logoUrl,
    primaryColor: agency.primaryColor,
    supportEmail: agency.supportEmail,
    hidePoweredBy: agency.hidePoweredBy,
    agencyId: agency.id,
    customDomain: agency.domainVerifiedAt ? agency.customDomain : null,
    emailFromName: agency.emailFromName,
    emailReplyTo: agency.emailReplyTo,
  };
}

/** The brand people in a business see: its agency's, or the platform's. */
export async function brandForBusiness(businessId: string): Promise<ResolvedBrand> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { agency: true } });
  return brandOfAgency(business?.agency);
}

/** "App.Agency.com:443" -> "app.agency.com"; null for anything that isn't a hostname. */
export function normaliseHost(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).host;
  } catch {
    return null;
  }
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

/** The brand for a verified custom domain, or null when the host isn't one. */
export async function brandForHost(host: string | null | undefined): Promise<ResolvedBrand | null> {
  const domain = normaliseHost(host);
  if (!domain) return null;
  const agency = await prisma.agency.findUnique({ where: { customDomain: domain } });
  return agency?.domainVerifiedAt ? brandOfAgency(agency) : null;
}

/** Base URL for links to the web app: the brand's own domain when it has one. */
export function webAppUrlFor(brand: ResolvedBrand, fallback: string): string {
  return brand.customDomain ? `https://${brand.customDomain}` : fallback.replace(/\/+$/, "");
}
