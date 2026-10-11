import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import bcrypt from "bcryptjs";
import { prisma } from "@platform/database";
import { signBusinessToken, signUserToken } from "@platform/shared-auth";
import { type BusinessRole, type BusinessSummary, type User as UserDto } from "@platform/shared-types";
import { RolesService } from "../roles/roles.service";
import { MailService } from "../mail/mail.service";
import { loginCodeEmail } from "../mail/templates";

const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

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

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid email or password");
    }

    // Password is right; the token is only issued once the emailed code is
    // entered (POST /auth/login/verify). Any older open challenge is retired.
    await prisma.loginChallenge.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const challenge = await prisma.loginChallenge.create({
      data: { userId: user.id, codeHash: "", expiresAt: this.codeExpiry() },
    });
    await this.issueCode(challenge.id, user.email);

    return {
      challengeId: challenge.id,
      email: maskEmail(user.email),
      codeLength: 4,
      expiresInSeconds: CODE_TTL_MINUTES * 60,
      resendInSeconds: RESEND_COOLDOWN_SECONDS,
    };
  }

  async verifyLoginCode(challengeId: string, code: string) {
    const challenge = await this.openChallenge(challengeId);
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      throw new HttpException("Too many incorrect codes. Sign in again.", HttpStatus.TOO_MANY_REQUESTS);
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
        left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect codes. Sign in again.",
      );
    }

    // Conditional update so two concurrent verifies can't both succeed.
    const { count } = await prisma.loginChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException("This code has already been used. Sign in again.");

    return {
      userToken: signUserToken(challenge.user.id),
      user: toUserDto(challenge.user),
      businesses: await this.businessesForUser(challenge.user.id),
    };
  }

  async resendLoginCode(challengeId: string) {
    const challenge = await this.openChallenge(challengeId);
    const waitMs = challenge.lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
    if (waitMs > 0) {
      throw new HttpException(
        `Wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.issueCode(challenge.id, challenge.user.email);
    return { expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: RESEND_COOLDOWN_SECONDS };
  }

  /** New code for a challenge: resets attempts and expiry, then emails it. */
  private async issueCode(challengeId: string, email: string) {
    const code = generateCode();
    await prisma.loginChallenge.update({
      where: { id: challengeId },
      data: { codeHash: hashCode(challengeId, code), attempts: 0, expiresAt: this.codeExpiry(), lastSentAt: new Date() },
    });
    await this.mailService.send(loginCodeEmail(email, code, CODE_TTL_MINUTES));
  }

  private async openChallenge(challengeId: string) {
    const challenge = await prisma.loginChallenge.findUnique({
      where: { id: challengeId },
      include: { user: true },
    });
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("This code has expired. Sign in again.");
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
  async createBusinessSession(userId: string, businessId: string) {
    const membership = await prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
      include: { business: true },
    });
    if (!membership) {
      throw new ForbiddenException("You are not a member of this business");
    }

    const role = membership.role as BusinessRole;
    const permissions = await this.rolesService.resolvePermissions(businessId, role);

    return {
      accessToken: signBusinessToken({ userId, businessId, role, permissions }),
      business: {
        id: membership.business.id,
        name: membership.business.name,
        slug: membership.business.slug,
      },
      role,
      permissions,
    };
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
