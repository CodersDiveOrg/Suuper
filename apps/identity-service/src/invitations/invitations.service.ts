import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import bcrypt from "bcryptjs";
import { memberSeats, prisma, recordAuditEvent } from "@platform/database";
import { planFor, quotaExceededBody } from "@platform/shared-types";
import { signUserToken } from "@platform/shared-auth";
import type { BusinessRole } from "@platform/shared-types";
import { RolesService, type RoleActor } from "../roles/roles.service";
import { MailService } from "../mail/mail.service";
import { invitationEmail } from "../mail/templates";

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type InvitationRow = {
  id: string;
  businessId: string;
  email: string;
  role: string;
  status: string;
  invitedByUserId: string;
  expiresAt: Date;
  createdAt: Date;
};

// The raw token only lives in the emailed link; the database stores its hash.
function newToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function webAppUrl() {
  return (process.env.WEB_APP_URL || "http://localhost:3200").replace(/\/+$/, "");
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly rolesService: RolesService,
    private readonly mailService: MailService,
  ) {}

  async create(businessId: string, invitedByUserId: string, actor: RoleActor, email: string, role: string) {
    const normalisedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
      throw new BadRequestException("A valid email is required");
    }
    await this.rolesService.assertAssignable(businessId, actor, role);

    const alreadyMember = await prisma.membership.findFirst({
      where: { businessId, user: { email: normalisedEmail } },
    });
    if (alreadyMember) {
      throw new ConflictException("That email already belongs to a member of this business");
    }

    const existing = await prisma.invitation.findUnique({
      where: { businessId_email: { businessId, email: normalisedEmail } },
    });
    if (existing && this.effectiveStatus(existing) === "pending") {
      throw new ConflictException("An invitation for this email is already pending. Use Resend instead.");
    }

    // Pending invitations hold a seat, so the plan's member limit counts them.
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { plan: true } });
    const plan = planFor(business?.plan);
    if ((await memberSeats(businessId)) >= plan.limits.members) {
      throw new HttpException(quotaExceededBody("members", plan), HttpStatus.PAYMENT_REQUIRED);
    }

    const token = newToken();
    const data = {
      businessId,
      email: normalisedEmail,
      role,
      tokenHash: hashToken(token),
      invitedByUserId,
      status: "pending",
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    };
    const invitation = existing
      ? await prisma.invitation.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() } })
      : await prisma.invitation.create({ data });

    const emailSent = await this.sendInvitationEmail(invitation, token);
    return { ...this.serialize(invitation), emailSent };
  }

  /** New link + fresh expiry for a pending (or expired) invitation; the old link stops working. */
  async resend(businessId: string, actor: RoleActor & { userId: string }, invitationId: string) {
    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation || invitation.businessId !== businessId) {
      throw new NotFoundException("Invitation not found");
    }
    if (invitation.status !== "pending") {
      throw new BadRequestException(`Invitation is already ${invitation.status}`);
    }
    // The role may have changed since it was sent; re-check the actor can still grant it.
    await this.rolesService.assertAssignable(businessId, actor, invitation.role);

    const token = newToken();
    const updated = await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedByUserId: actor.userId,
      },
    });
    const emailSent = await this.sendInvitationEmail(updated, token);
    return { ...this.serialize(updated), emailSent };
  }

  async listPending(businessId: string) {
    const invitations = await prisma.invitation.findMany({
      where: { businessId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    return invitations.map((i) => this.serialize(i));
  }

  async revoke(businessId: string, invitationId: string) {
    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation || invitation.businessId !== businessId) {
      throw new NotFoundException("Invitation not found");
    }
    if (invitation.status !== "pending") {
      throw new BadRequestException(`Invitation is already ${invitation.status}`);
    }
    await prisma.invitation.update({ where: { id: invitationId }, data: { status: "revoked" } });
  }

  /**
   * Public preview for the accept page. Only someone holding the emailed link
   * can call this, so it's fine to say whether the invitee already has an
   * account (which decides "sign in" vs "create account").
   */
  async preview(token: string) {
    const invitation = await this.findByToken(token);
    const status = this.effectiveStatus(invitation);
    const [inviter, roleNames, account] = await Promise.all([
      prisma.user.findUnique({ where: { id: invitation.invitedByUserId }, select: { name: true, email: true } }),
      this.rolesService.roleNames(invitation.businessId),
      prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } }),
    ]);
    return {
      businessName: invitation.business.name,
      email: invitation.email,
      role: invitation.role as BusinessRole,
      roleName: roleNames.get(invitation.role) ?? invitation.role,
      invitedBy: inviter?.name ?? inviter?.email,
      expiresAt: invitation.expiresAt.toISOString(),
      status,
      accountExists: !!account,
    };
  }

  /** Existing account: accept while signed in as the invited email. */
  async accept(token: string, userId: string) {
    const invitation = await this.findByToken(token);
    this.assertPending(invitation);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("Account no longer exists");
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException("This invitation was sent to a different email address");
    }

    await this.join(invitation, async () => user.id);
    return { businessId: invitation.businessId, role: invitation.role as BusinessRole };
  }

  /**
   * New account from an invitation. Receiving the link proves the invitee owns
   * the email address, so no separate verification code is needed — which is
   * also why the link is never shown to the inviter.
   */
  async registerAndAccept(token: string, input: { name?: string; password?: string }) {
    const invitation = await this.findByToken(token);
    this.assertPending(invitation);

    const name = input.name?.trim() ?? "";
    if (name.length < 2 || name.length > 80) {
      throw new BadRequestException("Name must be between 2 and 80 characters");
    }
    if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (await prisma.user.findUnique({ where: { email: invitation.email } })) {
      throw new ConflictException("An account already exists for this email. Sign in to accept the invitation.");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    // Account creation is inside the same transaction, so a failed accept
    // never leaves an orphaned account behind.
    const user = await this.join(invitation, (tx) =>
      tx.user.create({ data: { email: invitation.email, name, passwordHash } }),
    );

    return {
      userToken: signUserToken(user.id),
      user: { id: user.id, email: user.email, name: user.name ?? undefined, createdAt: user.createdAt.toISOString() },
      businessId: invitation.businessId,
    };
  }

  /**
   * Mark accepted + create the membership atomically; the status guard makes
   * the link single-use even under concurrent requests. `resolveUser` runs
   * inside the transaction and returns the joining user (or their id).
   */
  private async join<U extends string | { id: string }>(
    invitation: { id: string; businessId: string; role: string },
    resolveUser: (tx: TransactionClient) => Promise<U>,
  ): Promise<U> {
    const joined = await prisma.$transaction(async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, status: "pending" },
        data: { status: "accepted" },
      });
      if (count === 0) throw new BadRequestException("This invitation has already been used");
      const user = await resolveUser(tx);
      const userId = typeof user === "string" ? user : user.id;
      await tx.membership.upsert({
        where: { userId_businessId: { userId, businessId: invitation.businessId } },
        update: {},
        create: { userId, businessId: invitation.businessId, role: invitation.role },
      });
      return user;
    });
    // Accepting is signed with a user token, so the audit middleware doesn't see it.
    const userId = typeof joined === "string" ? joined : joined.id;
    await recordAuditEvent({
      businessId: invitation.businessId,
      actorId: userId,
      action: "member.joined",
      resourceType: "member",
      resourceId: userId,
      details: { values: { role: invitation.role } },
    });
    return joined;
  }

  /** Returns whether the email went out; a failed send leaves the invite in place to Resend. */
  private async sendInvitationEmail(invitation: InvitationRow, token: string) {
    const [business, inviter, roleNames] = await Promise.all([
      prisma.business.findUniqueOrThrow({ where: { id: invitation.businessId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: invitation.invitedByUserId }, select: { name: true, email: true } }),
      this.rolesService.roleNames(invitation.businessId),
    ]);
    try {
      await this.mailService.send(
        invitationEmail({
          to: invitation.email,
          businessName: business.name,
          inviterName: inviter?.name ?? inviter?.email ?? "A teammate",
          roleName: roleNames.get(invitation.role) ?? invitation.role,
          acceptUrl: `${webAppUrl()}/invite/${token}`,
          expiresInDays: INVITE_TTL_DAYS,
        }),
      );
      return true;
    } catch (err) {
      this.logger.warn(`Invitation ${invitation.id} saved but email failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async findByToken(token: string) {
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { business: { select: { name: true } } },
    });
    if (!invitation) {
      throw new NotFoundException("Invitation not found");
    }
    return invitation;
  }

  private assertPending(invitation: { status: string; expiresAt: Date }) {
    const status = this.effectiveStatus(invitation);
    if (status !== "pending") {
      throw new BadRequestException(
        status === "expired" ? "This invitation has expired. Ask for a new one." : `This invitation has been ${status}.`,
      );
    }
  }

  private effectiveStatus(invitation: { status: string; expiresAt: Date }) {
    if (invitation.status === "pending" && invitation.expiresAt.getTime() < Date.now()) {
      return "expired" as const;
    }
    return invitation.status as "pending" | "accepted" | "revoked" | "expired";
  }

  private serialize(invitation: InvitationRow) {
    return {
      id: invitation.id,
      businessId: invitation.businessId,
      email: invitation.email,
      role: invitation.role as BusinessRole,
      status: this.effectiveStatus(invitation),
      invitedByUserId: invitation.invitedByUserId,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }
}
