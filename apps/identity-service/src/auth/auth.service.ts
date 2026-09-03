import { Injectable, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@platform/database";
import type { TenantRole } from "@platform/shared-types";

export interface AuthenticatedUser {
  id: string;
  email: string;
  tenantId: string;
  roles: TenantRole[];
}

@Injectable()
export class AuthService {
  private readonly jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";

  async login(email: string, password: string): Promise<{ accessToken: string; user: AuthenticatedUser }> {
    // Single-tenant-per-email lookup for now: email is unique per tenant, not
    // globally. Fine for the seeded single-tenant dev flow; a real login
    // needs tenant selection (subdomain/slug) once multiple tenants share an
    // email domain.
    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: [user.role as TenantRole],
    };

    const accessToken = jwt.sign(
      { tenantId: user.tenantId, userId: user.id, roles: authenticatedUser.roles },
      this.jwtSecret,
      { expiresIn: "7d" },
    );

    return { accessToken, user: authenticatedUser };
  }

  async me(userId: string, tenantId: string): Promise<AuthenticatedUser> {
    const user = await prisma.user.findFirstOrThrow({ where: { id: userId, tenantId } });
    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: [user.role as TenantRole],
    };
  }
}
