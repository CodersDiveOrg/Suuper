import { randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { normaliseHost, prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import {
  AGENCY_PLANS,
  ALL_PERMISSIONS,
  agencyPlanFor,
  isAgencyPlanKey,
  isPlanKey,
  planFor,
  type AgencyClient,
  type AgencyDetail,
  type AgencyDomain,
  type AgencyMemberRow,
  type AgencyRole,
  type AgencySummary,
  type PlanKey,
} from "@platform/shared-types";
import { BusinessesService } from "../businesses/businesses.service";
import { InvitationsService } from "../invitations/invitations.service";

const config = loadServiceConfig("identity-service", 3001);
const MAX_SLUG_ATTEMPTS = 20;
const HEX = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Host clients' custom domains CNAME to.
const PLATFORM_HOST = process.env.PLATFORM_HOST || new URL(config.webAppUrl).hostname;
const TXT_PREFIX = "_suuper-verify";

type AgencyRow = NonNullable<Awaited<ReturnType<typeof prisma.agency.findUnique>>>;

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Agency plans are paid through Stripe once these are set; until then owners pick a plan directly. */
export function agencyBillingConfigured() {
  return !!process.env.STRIPE_SECRET_KEY && AGENCY_PLANS.every((plan) => !!process.env[`STRIPE_PRICE_${plan.key.toUpperCase()}`]);
}

@Injectable()
export class AgenciesService {
  constructor(
    private readonly businesses: BusinessesService,
    private readonly invitations: InvitationsService,
  ) {}

  // --- Agencies ------------------------------------------------------------------

  async listForUser(userId: string): Promise<AgencySummary[]> {
    const rows = await prisma.agencyMember.findMany({
      where: { userId },
      include: { agency: { include: { _count: { select: { businesses: true } } } } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => this.summary(row.agency, row.role, row.agency._count.businesses));
  }

  async create(userId: string, name: unknown): Promise<AgencySummary> {
    const trimmed = this.text(name, "name", 80, 2)!;
    const slug = await this.uniqueSlug(trimmed);
    const agency = await prisma.$transaction(async (tx) => {
      const created = await tx.agency.create({ data: { name: trimmed, slug } });
      await tx.agencyMember.create({ data: { agencyId: created.id, userId, role: "owner" } });
      return created;
    });
    return this.summary(agency, "owner", 0);
  }

  async detail(agencyId: string, userId: string): Promise<AgencyDetail> {
    const { agency, role } = await this.staff(agencyId, userId);
    const clientCount = await prisma.business.count({ where: { agencyId } });
    const plan = agencyPlanFor(agency.plan);
    return {
      ...this.summary(agency, role, clientCount),
      brandName: agency.brandName,
      logoUrl: agency.logoUrl,
      primaryColor: agency.primaryColor,
      supportEmail: agency.supportEmail,
      hidePoweredBy: agency.hidePoweredBy,
      emailFromName: agency.emailFromName,
      emailReplyTo: agency.emailReplyTo,
      domain: this.domainOf(agency),
      limits: { clients: plan.clients, clientPlans: plan.clientPlans, customDomain: plan.customDomain },
      canChangePlanDirectly: !agencyBillingConfigured(),
      createdAt: agency.createdAt.toISOString(),
    };
  }

  /** Name and white-label settings. Owners only. */
  async update(agencyId: string, userId: string, input: Record<string, unknown>) {
    await this.staff(agencyId, userId, "owner");
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = this.text(input.name, "name", 80, 2);
    if (input.brandName !== undefined) data.brandName = this.text(input.brandName, "brandName", 60);
    if (input.logoUrl !== undefined) {
      const url = this.text(input.logoUrl, "logoUrl", 500);
      if (url && !/^https:\/\/\S+$/.test(url)) throw new BadRequestException("logoUrl must be an https:// link to an image");
      data.logoUrl = url;
    }
    if (input.primaryColor !== undefined) {
      const color = this.text(input.primaryColor, "primaryColor", 7);
      if (color && !HEX.test(color)) throw new BadRequestException("primaryColor must be a hex colour like #4f46e5");
      data.primaryColor = color?.toLowerCase() ?? null;
    }
    for (const key of ["supportEmail", "emailReplyTo"] as const) {
      if (input[key] === undefined) continue;
      const email = this.text(input[key], key, 200)?.toLowerCase() ?? null;
      if (email && !EMAIL.test(email)) throw new BadRequestException(`${key} must be an email address`);
      data[key] = email;
    }
    if (input.emailFromName !== undefined) data.emailFromName = this.text(input.emailFromName, "emailFromName", 60);
    if (input.hidePoweredBy !== undefined) data.hidePoweredBy = input.hidePoweredBy === true;
    await prisma.agency.update({ where: { id: agencyId }, data });
    return this.detail(agencyId, userId);
  }

  /** Direct plan change, for servers without agency payments set up. */
  async setPlan(agencyId: string, userId: string, plan: unknown) {
    await this.staff(agencyId, userId, "owner");
    if (agencyBillingConfigured()) throw new BadRequestException("Agency plans are changed through billing");
    if (!isAgencyPlanKey(plan)) throw new BadRequestException(`plan must be one of: ${AGENCY_PLANS.map((p) => p.key).join(", ")}`);
    await prisma.agency.update({ where: { id: agencyId }, data: { plan } });
    return this.detail(agencyId, userId);
  }

  // --- Clients -------------------------------------------------------------------

  async clients(agencyId: string, userId: string): Promise<AgencyClient[]> {
    await this.staff(agencyId, userId);
    const rows = await prisma.business.findMany({
      where: { agencyId },
      include: {
        _count: { select: { memberships: true, bots: true, apps: true } },
        invitations: { where: { role: "owner", status: "pending", expiresAt: { gt: new Date() } }, select: { email: true }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    });
    const replies = rows.length
      ? await prisma.usageEvent.groupBy({
          by: ["businessId"],
          where: { businessId: { in: rows.map((r) => r.id) }, type: "bot_reply", createdAt: { gte: monthStart() } },
          _count: { _all: true },
        })
      : [];
    const repliesBy = new Map(replies.map((r) => [r.businessId, r._count._all]));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan,
      memberCount: row._count.memberships,
      botCount: row._count.bots,
      appCount: row._count.apps,
      repliesThisMonth: repliesBy.get(row.id) ?? 0,
      pendingOwnerEmail: row.invitations[0]?.email ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** A new client business; optionally invites its owner by email. */
  async createClient(agencyId: string, userId: string, input: { name?: unknown; plan?: unknown; ownerEmail?: unknown }) {
    const { agency } = await this.staff(agencyId, userId);
    const agencyPlan = agencyPlanFor(agency.plan);
    const count = await prisma.business.count({ where: { agencyId } });
    if (count >= agencyPlan.clients) {
      throw new HttpException(
        { message: `${agencyPlan.name} includes ${agencyPlan.clients} clients. Upgrade the agency plan to add more.`, code: "agency_client_limit" },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const name = this.text(input.name, "name", 80, 2)!;
    const plan = this.clientPlan(input.plan ?? agencyPlan.clientPlans[0], agencyPlan.clientPlans);
    const ownerEmail = this.text(input.ownerEmail, "ownerEmail", 200)?.toLowerCase() ?? null;
    if (ownerEmail && !EMAIL.test(ownerEmail)) throw new BadRequestException("ownerEmail must be an email address");

    const business = await prisma.business.create({
      data: { name, slug: await this.businesses.uniqueSlug(name), plan, agencyId },
    });
    let invitation: { emailSent: boolean } | null = null;
    if (ownerEmail) {
      invitation = await this.invitations.create(business.id, userId, { role: "owner", permissions: ALL_PERMISSIONS }, ownerEmail, "owner");
    }
    return { id: business.id, name: business.name, slug: business.slug, plan, ownerInvited: !!invitation, emailSent: invitation?.emailSent ?? false };
  }

  async updateClient(agencyId: string, userId: string, businessId: string, input: { name?: unknown; plan?: unknown }) {
    const { agency } = await this.staff(agencyId, userId);
    await this.client(agencyId, businessId);
    const data: { name?: string; plan?: PlanKey } = {};
    if (input.name !== undefined) data.name = this.text(input.name, "name", 80, 2)!;
    if (input.plan !== undefined) data.plan = this.clientPlan(input.plan, agencyPlanFor(agency.plan).clientPlans);
    await prisma.business.update({ where: { id: businessId }, data });
    return (await this.clients(agencyId, userId)).find((c) => c.id === businessId);
  }

  /**
   * Hands a client over: the business leaves the agency (brand, staff access)
   * and carries on by itself. It needs an owner of its own first.
   */
  async detachClient(agencyId: string, userId: string, businessId: string) {
    await this.staff(agencyId, userId, "owner");
    await this.client(agencyId, businessId);
    const owners = await prisma.membership.count({ where: { businessId, role: "owner" } });
    if (owners === 0) throw new BadRequestException("This client has no owner of its own yet. Invite one and wait for them to join first.");
    await prisma.business.update({ where: { id: businessId }, data: { agencyId: null } });
    return { detached: true };
  }

  async resendOwnerInvite(agencyId: string, userId: string, businessId: string) {
    await this.staff(agencyId, userId);
    await this.client(agencyId, businessId);
    const invitation = await prisma.invitation.findFirst({ where: { businessId, role: "owner", status: "pending" } });
    if (!invitation) throw new NotFoundException("There's no pending owner invitation");
    return this.invitations.resend(businessId, { userId, role: "owner", permissions: ALL_PERMISSIONS }, invitation.id);
  }

  // --- Team ----------------------------------------------------------------------

  async members(agencyId: string, userId: string): Promise<AgencyMemberRow[]> {
    await this.staff(agencyId, userId);
    const rows = await prisma.agencyMember.findMany({ where: { agencyId }, include: { user: true }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      role: row.role as AgencyRole,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Adds someone who already has an account. */
  async addMember(agencyId: string, userId: string, input: { email?: unknown; role?: unknown }) {
    await this.staff(agencyId, userId, "owner");
    const email = this.text(input.email, "email", 200)?.toLowerCase();
    if (!email || !EMAIL.test(email)) throw new BadRequestException("A valid email is required");
    const role = this.agencyRole(input.role ?? "admin");
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException("No account uses that email yet. Ask them to sign up first, then add them.");
    const existing = await prisma.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId: user.id } } });
    if (existing) throw new ConflictException("They're already on the team");
    await prisma.agencyMember.create({ data: { agencyId, userId: user.id, role } });
    return this.members(agencyId, userId);
  }

  async changeMemberRole(agencyId: string, userId: string, targetUserId: string, role: unknown) {
    await this.staff(agencyId, userId, "owner");
    const next = this.agencyRole(role);
    const target = await this.member(agencyId, targetUserId);
    if (target.role === "owner" && next !== "owner") await this.assertAnotherOwner(agencyId);
    await prisma.agencyMember.update({ where: { id: target.id }, data: { role: next } });
    return this.members(agencyId, userId);
  }

  /** Owners remove anyone; anyone can leave. The last owner can't go. */
  async removeMember(agencyId: string, userId: string, targetUserId: string) {
    await this.staff(agencyId, userId, targetUserId === userId ? undefined : "owner");
    const target = await this.member(agencyId, targetUserId);
    if (target.role === "owner") await this.assertAnotherOwner(agencyId);
    await prisma.agencyMember.delete({ where: { id: target.id } });
    return { removed: true };
  }

  // --- Custom domain -------------------------------------------------------------

  async setDomain(agencyId: string, userId: string, value: unknown) {
    const { agency } = await this.staff(agencyId, userId, "owner");
    if (!agencyPlanFor(agency.plan).customDomain) {
      throw new HttpException({ message: "Custom domains come with Agency Growth and Scale.", code: "agency_plan_feature" }, HttpStatus.PAYMENT_REQUIRED);
    }
    const domain = normaliseHost(typeof value === "string" ? value : null);
    if (!domain) throw new BadRequestException("Enter a domain like app.youragency.com");
    if (domain === PLATFORM_HOST || domain.endsWith(`.${PLATFORM_HOST.split(".").slice(-2).join(".")}`)) {
      throw new BadRequestException("Use a domain you own");
    }
    const taken = await prisma.agency.findUnique({ where: { customDomain: domain } });
    if (taken && taken.id !== agencyId) throw new ConflictException("Another agency already uses that domain");
    if (agency.customDomain !== domain) {
      await prisma.agency.update({
        where: { id: agencyId },
        data: { customDomain: domain, domainVerifiedAt: null, domainToken: randomUUID() },
      });
    }
    return this.detail(agencyId, userId);
  }

  async removeDomain(agencyId: string, userId: string) {
    await this.staff(agencyId, userId, "owner");
    await prisma.agency.update({ where: { id: agencyId }, data: { customDomain: null, domainVerifiedAt: null } });
    return this.detail(agencyId, userId);
  }

  /** Looks up the TXT record; on a match the domain starts serving the brand. */
  async verifyDomain(agencyId: string, userId: string) {
    const { agency } = await this.staff(agencyId, userId, "owner");
    if (!agency.customDomain) throw new BadRequestException("Add a domain first");
    let records: string[] = [];
    try {
      records = (await resolveTxt(`${TXT_PREFIX}.${agency.customDomain}`)).map((chunks) => chunks.join(""));
    } catch {
      records = [];
    }
    if (!records.some((r) => r.trim() === this.txtValue(agency))) {
      throw new BadRequestException(
        `Couldn't find the TXT record yet. Add ${TXT_PREFIX}.${agency.customDomain} with the value shown, then try again. DNS changes can take a few minutes.`,
      );
    }
    await prisma.agency.update({ where: { id: agencyId }, data: { domainVerifiedAt: new Date() } });
    return this.detail(agencyId, userId);
  }

  // --- Helpers -------------------------------------------------------------------

  /** The caller's place in the agency; with `need: "owner"`, only owners pass. */
  private async staff(agencyId: string, userId: string, need?: AgencyRole) {
    const row = await prisma.agencyMember.findUnique({
      where: { agencyId_userId: { agencyId, userId } },
      include: { agency: true },
    });
    if (!row) throw new NotFoundException("Agency not found");
    if (need === "owner" && row.role !== "owner") throw new ForbiddenException("Only agency owners can do that");
    return { agency: row.agency, role: row.role as AgencyRole };
  }

  private async client(agencyId: string, businessId: string) {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business || business.agencyId !== agencyId) throw new NotFoundException("Client not found");
    return business;
  }

  private async member(agencyId: string, userId: string) {
    const row = await prisma.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } });
    if (!row) throw new NotFoundException("Team member not found");
    return row;
  }

  private async assertAnotherOwner(agencyId: string) {
    const owners = await prisma.agencyMember.count({ where: { agencyId, role: "owner" } });
    if (owners <= 1) throw new BadRequestException("An agency needs at least one owner. Make someone else an owner first.");
  }

  private summary(agency: AgencyRow, role: string, clientCount: number): AgencySummary {
    return { id: agency.id, name: agency.name, slug: agency.slug, role: role as AgencyRole, plan: agencyPlanFor(agency.plan).key, clientCount };
  }

  private txtValue(agency: AgencyRow) {
    return `suuper-verify=${agency.domainToken}`;
  }

  private domainOf(agency: AgencyRow): AgencyDomain | null {
    if (!agency.customDomain) return null;
    return {
      domain: agency.customDomain,
      verified: !!agency.domainVerifiedAt,
      verifiedAt: agency.domainVerifiedAt?.toISOString() ?? null,
      records: [
        { type: "CNAME", name: agency.customDomain, value: PLATFORM_HOST },
        { type: "TXT", name: `${TXT_PREFIX}.${agency.customDomain}`, value: this.txtValue(agency) },
      ],
    };
  }

  private clientPlan(value: unknown, allowed: PlanKey[]): PlanKey {
    if (!isPlanKey(value)) throw new BadRequestException("plan must be starter, growth or pro");
    if (!allowed.includes(value)) {
      throw new HttpException(
        { message: `Your agency plan lets clients use: ${allowed.map((p) => planFor(p).name).join(", ")}.`, code: "agency_plan_feature" },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return value;
  }

  private agencyRole(value: unknown): AgencyRole {
    if (value !== "owner" && value !== "admin") throw new BadRequestException("role must be owner or admin");
    return value;
  }

  /** Trimmed string or null (empty clears); throws on the wrong type or length. */
  private text(value: unknown, field: string, max: number, min = 0): string | null {
    if (value === null || value === undefined) {
      if (min > 0) throw new BadRequestException(`${field} is required`);
      return null;
    }
    if (typeof value !== "string") throw new BadRequestException(`${field} must be text`);
    const trimmed = value.trim();
    if (!trimmed) {
      if (min > 0) throw new BadRequestException(`${field} is required`);
      return null;
    }
    if (trimmed.length < min || trimmed.length > max) throw new BadRequestException(`${field} must be ${min}–${max} characters`);
    return trimmed;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agency";
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      if (!(await prisma.agency.findUnique({ where: { slug: candidate } }))) return candidate;
    }
    throw new BadRequestException("Could not generate a unique slug for that name");
  }
}
