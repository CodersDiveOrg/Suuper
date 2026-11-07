import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  ForbiddenException,
  ServiceUnavailableException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { brandForHost, platformBrand, prisma, recordAuditEvent, type ResolvedBrand } from "@platform/database";
import { signBusinessToken, signUserToken } from "@platform/shared-auth";
import { ALL_PERMISSIONS, type BusinessRole, type BusinessSummary, type User as UserDto } from "@platform/shared-types";
import { RolesService } from "../roles/roles.service";
import { MailService } from "../mail/mail.service";
import { loginCodeEmail, passwordResetEmail } from "../mail/templates";

const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

/** What a challenge's code unlocks; a code is only accepted by its own purpose's endpoint. */
type ChallengePurpose = "login" | "password_reset";

/** What to tell the user to do when a challenge can no longer be used. */
const RESTART: Record<ChallengePurpose, string> = { login: "Sign in again.", password_reset: "Request a new code." };

function generateCode() {
  return randomInt(0, 10_000).toString().padStart(4, "0");
}

// Keyed hash: a leaked LoginChallenge row can't be brute-forced offline
// without the server secret (4 digits is only 10k possibilities).
function hashCode(challengeId: string, code: string) {
  const secret = process.env.JWT_SECRET ?? "dev-secret-change-me";
  return createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("hex");
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function toUserDto(user: {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
}): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? undefined,
    createdAt: user.createdAt.toISOString(),
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly rolesService: RolesService,
    private readonly mailService: MailService,
  ) {}

  async register(email: string, password: string, name?: string) {
    const normalisedEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalisedEmail } });
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }

    const user = await prisma.user.create({
      data: {
        email: normalisedEmail,
        name: name?.trim() || null,
        passwordHash: await bcrypt.hash(password, 10),
      },
    });

    return { userToken: signUserToken(user.id), user: toUserDto(user) };
  }

  private googleClient?: OAuth2Client;

  /**
   * Sign in (or sign up) with a Google ID token from "Sign in with Google".
   * Google has already confirmed the email, so no emailed code is needed. An
   * existing account with that email is signed in; otherwise one is created.
   */
  async googleSignIn(credential: string) {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      throw new ServiceUnavailableException("Google sign-in isn't set up on this server.");
    }
    this.googleClient ??= new OAuth2Client(clientId);

    let payload: { email?: string; email_verified?: boolean; name?: string } | undefined;
    try {
      // Checks Google's signature, expiry, issuer and that it was issued for our client ID.
      const ticket = await this.googleClient.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException("Google sign-in failed. Try again.");
    }
    if (!payload?.email || !payload.email_verified) {
      throw new UnauthorizedException("Your Google account's email isn't verified.");
    }

    const email = payload.email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    const created = !user;
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: payload.name?.trim() || null,
          // No password yet: an unguessable hash. "Forgot password" can set a real one later.
          passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
        },
      });
    }

    return {
      userToken: signUserToken(user.id),
      user: toUserDto(user),
      businesses: await this.businessesForUser(user.id),
      created,
    };
  }

  /** Login codes carry the brand of the custom domain the user signs in on. */
  private async brandFor(origin?: string): Promise<ResolvedBrand> {
    return (await brandForHost(origin)) ?? platformBrand();
  }

  async login(email: string, password: string, origin?: string) {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid email or password");
    }

    // Password is right; the token is only issued once the emailed code is
    // entered (POST /auth/login/verify). Any older open challenge is retired.
    await prisma.loginChallenge.updateMany({
      where: { userId: user.id, consumedAt: null, purpose: "login" },
      data: { consumedAt: new Date() },
    });
    const challenge = await prisma.loginChallenge.create({
      data: { userId: user.id, codeHash: "", purpose: "login", expiresAt: this.codeExpiry() },
    });
    await this.issueCode(challenge.id, user.email, await this.brandFor(origin), "login");

    return {
      challengeId: challenge.id,
      email: maskEmail(user.email),
      codeLength: 4,
      expiresInSeconds: CODE_TTL_MINUTES * 60,
      resendInSeconds: RESEND_COOLDOWN_SECONDS,
    };
  }

  async verifyLoginCode(challengeId: string, code: string) {
    const challenge = await this.openChallenge(challengeId, "login");
    await this.consumeWithCode(challenge, code, "login");

    return {
      userToken: signUserToken(challenge.user.id),
      user: toUserDto(challenge.user),
      businesses: await this.businessesForUser(challenge.user.id),
    };
  }

  async resendLoginCode(challengeId: string, origin?: string) {
    return this.resendCode(challengeId, "login", origin);
  }

  /**
   * Starts a password reset: emails a 4-digit code if the address has an account.
   * The response is the same either way, so it can't be used to discover which
   * emails are registered.
   */
  async forgotPassword(email: string, origin?: string) {
    const normalisedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalisedEmail } });
    let challengeId: string = randomUUID();
    if (user) {
      await prisma.loginChallenge.updateMany({
        where: { userId: user.id, consumedAt: null, purpose: "password_reset" },
        data: { consumedAt: new Date() },
      });
      const challenge = await prisma.loginChallenge.create({
        data: { userId: user.id, codeHash: "", purpose: "password_reset", expiresAt: this.codeExpiry() },
      });
      challengeId = challenge.id;
      await this.issueCode(challenge.id, user.email, await this.brandFor(origin), "password_reset");
    }
    return {
      challengeId,
      email: maskEmail(normalisedEmail),
      codeLength: 4,
      expiresInSeconds: CODE_TTL_MINUTES * 60,
      resendInSeconds: RESEND_COOLDOWN_SECONDS,
    };
  }

  /** Finishes a password reset: checks the emailed code, then sets the new password. */
  async resetPassword(challengeId: string, code: string, password: string) {
    const challenge = await this.openChallenge(challengeId, "password_reset");
    await this.consumeWithCode(challenge, code, "password_reset");
    await prisma.user.update({
      where: { id: challenge.user.id },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });
    // Anything still open was started with the old password: retire it.
    await prisma.loginChallenge.updateMany({
      where: { userId: challenge.user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return { reset: true, email: challenge.user.email };
  }

  async resendPasswordResetCode(challengeId: string, origin?: string) {
    return this.resendCode(challengeId, "password_reset", origin);
  }

  private async resendCode(challengeId: string, purpose: ChallengePurpose, origin?: string) {
    const challenge = await this.openChallenge(challengeId, purpose);
    const waitMs = challenge.lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
    if (waitMs > 0) {
      throw new HttpException(
        `Wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.issueCode(challenge.id, challenge.user.email, await this.brandFor(origin), purpose);
    return { expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: RESEND_COOLDOWN_SECONDS };
  }

  /** Checks a code against an open challenge (counting failed attempts) and marks it used. */
  private async consumeWithCode(challenge: { id: string; codeHash: string; attempts: number }, code: string, purpose: ChallengePurpose) {
    const restart = RESTART[purpose];
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      throw new HttpException(`Too many incorrect codes. ${restart}`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const expected = Buffer.from(challenge.codeHash, "hex");
    const actual = Buffer.from(hashCode(challenge.id, code.trim()), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      const updated = await prisma.loginChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      const left = MAX_CODE_ATTEMPTS - updated.attempts;
      throw new BadRequestException(
        left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : `Too many incorrect codes. ${restart}`,
      );
    }

    // Conditional update so two concurrent verifies can't both succeed.
    const { count } = await prisma.loginChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException(`This code has already been used. ${restart}`);
  }

  /** New code for a challenge: resets attempts and expiry, then emails it. */
  private async issueCode(challengeId: string, email: string, brand: ResolvedBrand, purpose: ChallengePurpose) {
    const code = generateCode();
    await prisma.loginChallenge.update({
      where: { id: challengeId },
      data: { codeHash: hashCode(challengeId, code), attempts: 0, expiresAt: this.codeExpiry(), lastSentAt: new Date() },
    });
    const message = purpose === "password_reset" ? passwordResetEmail : loginCodeEmail;
    await this.mailService.send(message(email, code, CODE_TTL_MINUTES, brand));
  }

  private async openChallenge(challengeId: string, purpose: ChallengePurpose) {
    const challenge = await prisma.loginChallenge.findUnique({
      where: { id: challengeId },
      include: { user: true },
    });
    // A code from one flow never opens the other (e.g. a reset code can't sign you in).
    if (!challenge || challenge.purpose !== purpose || challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException(`This code has expired. ${RESTART[purpose]}`);
    }
    return challenge;
  }

  private codeExpiry() {
    return new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  }

  async me(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException("Account no longer exists");
    }
    return { user: toUserDto(user), businesses: await this.businessesForUser(userId) };
  }

  /** Exchange a user token for a business-scoped token for one of the user's businesses. */
  async createBusinessSession(userId: string, businessId: string, origin?: { ip: string | null; userAgent: string | null }) {
    const membership = await prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
      include: { business: true },
    });
    // Agency staff open their clients' workspaces without a membership:
    // agency owners as owner, agency admins as admin.
    const viaAgency = membership ? null : await this.agencyAccess(userId, businessId);
    if (!membership && !viaAgency) {
      throw new ForbiddenException("You are not a member of this business");
    }
    const business = membership?.business ?? viaAgency!.business;

    const role = (membership?.role ?? viaAgency!.role) as BusinessRole;
    const permissions =
      viaAgency?.role === "owner" ? ALL_PERMISSIONS : await this.rolesService.resolvePermissions(businessId, role);
    // Opening a workspace is its sign-in (the user-level login has no business yet).
    await recordAuditEvent({ businessId, actorId: userId, action: "member.signed_in", resourceType: "member", resourceId: userId, ...(viaAgency ? { details: { values: { via: "agency" } } } : {}), ...origin });

    return {
      accessToken: signBusinessToken({ userId, businessId, role, permissions }),
      business: {
        id: business.id,
        name: business.name,
        slug: business.slug,
      },
      role,
      permissions,
      viaAgency: viaAgency ? { id: viaAgency.agencyId } : null,
    };
  }

  private async agencyAccess(userId: string, businessId: string) {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business?.agencyId) return null;
    const staff = await prisma.agencyMember.findUnique({
      where: { agencyId_userId: { agencyId: business.agencyId, userId } },
    });
    return staff ? { business, role: staff.role === "owner" ? "owner" : "admin", agencyId: business.agencyId } : null;
  }

  private async businessesForUser(userId: string): Promise<BusinessSummary[]> {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { business: true },
      orderBy: { createdAt: "asc" },
    });

    return memberships.map((m) => ({
      id: m.business.id,
      name: m.business.name,
      slug: m.business.slug,
      role: m.role as BusinessRole,
    }));
  }
}
