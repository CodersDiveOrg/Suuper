import jwt from "jsonwebtoken";
import type { BusinessRole, Permission } from "@platform/shared-types";

const secret = (): string => process.env.JWT_SECRET ?? "dev-secret-change-me";

/** Issued by identity-service after email/password login. Not scoped to a business. */
export interface UserTokenPayload {
  typ: "user";
  userId: string;
}

/**
 * Issued by identity-service when the user picks a business to act in
 * (POST /auth/businesses/:id/session). Carries the resolved role + permissions
 * so downstream services don't have to look the membership up again.
 */
export interface BusinessTokenPayload {
  typ: "business";
  userId: string;
  businessId: string;
  role: BusinessRole;
  permissions: Permission[];
}

const USER_TOKEN_TTL = "30d";
const BUSINESS_TOKEN_TTL = "1d";

export function signUserToken(userId: string): string {
  return jwt.sign({ typ: "user", userId } satisfies UserTokenPayload, secret(), {
    expiresIn: USER_TOKEN_TTL,
  });
}

export function signBusinessToken(payload: Omit<BusinessTokenPayload, "typ">): string {
  return jwt.sign({ typ: "business", ...payload } satisfies BusinessTokenPayload, secret(), {
    expiresIn: BUSINESS_TOKEN_TTL,
  });
}

export function verifyUserToken(token: string): UserTokenPayload {
  const payload = jwt.verify(token, secret()) as Partial<UserTokenPayload>;
  if (payload.typ !== "user" || !payload.userId) {
    throw new Error("Not a user token");
  }
  return { typ: "user", userId: payload.userId };
}

export function verifyBusinessToken(token: string): BusinessTokenPayload {
  const payload = jwt.verify(token, secret()) as Partial<BusinessTokenPayload>;
  if (payload.typ !== "business" || !payload.userId || !payload.businessId || !payload.role) {
    throw new Error("Not a business token");
  }
  return {
    typ: "business",
    userId: payload.userId,
    businessId: payload.businessId,
    role: payload.role,
    permissions: payload.permissions ?? [],
  };
}
