import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@platform/database";
import {
  type BusinessContext,
  type Permission,
  isBuiltInRole,
  isPermission,
  permissionsForRole,
} from "@platform/shared-types";

// Business API keys: "sk_live_" + 32 random bytes (base64url). Only the sha256
// is stored, so a database leak doesn't expose usable keys.
export const API_KEY_PREFIX = "sk_live_";
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 4;
// lastUsedAt is a hint, not an audit trail — don't write it on every request.
const LAST_USED_RESOLUTION_MS = 60_000;

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), keyHash: hashApiKey(key) };
}

/**
 * Resolves an API key to the business context it acts in, or null if it's
 * unknown, revoked, expired, or its creator has left the business. The key's
 * permissions are intersected with what the creator can do right now, so
 * demoting someone also narrows every key they made.
 */
export async function resolveApiKey(key: string): Promise<BusinessContext | null> {
  const row = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(key) } });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const membership = await prisma.membership.findUnique({
    where: { userId_businessId: { userId: row.createdByUserId, businessId: row.businessId } },
  });
  if (!membership) return null;

  let held: Permission[];
  if (isBuiltInRole(membership.role)) {
    held = permissionsForRole(membership.role);
  } else {
    const role = await prisma.role.findUnique({
      where: { businessId_key: { businessId: row.businessId, key: membership.role } },
    });
    held = (role?.permissions ?? []).filter(isPermission);
  }
  const heldSet = new Set(held);

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }

  return {
    userId: row.createdByUserId,
    businessId: row.businessId,
    role: membership.role,
    permissions: row.permissions.filter((p): p is Permission => isPermission(p) && heldSet.has(p)),
    apiKeyId: row.id,
  };
}
