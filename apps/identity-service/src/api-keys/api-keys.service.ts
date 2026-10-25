import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { generateApiKey } from "@platform/shared-auth";
import {
  type ApiKeyCreatedDto,
  type ApiKeyDto,
  type BusinessContext,
  type Permission,
  isPermission,
} from "@platform/shared-types";
import { RolesService } from "../roles/roles.service";

const MAX_ACTIVE_KEYS = 50;
const MAX_EXPIRY_DAYS = 365;
// A key can't mint or revoke other keys, so a leaked one can't entrench itself.
const NOT_GRANTABLE_TO_KEYS: Permission[] = ["apikeys:manage"];

interface ApiKeyInput {
  name?: unknown;
  permissions?: unknown;
  expiresInDays?: unknown;
}

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  createdByUserId: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class ApiKeysService {
  constructor(private readonly rolesService: RolesService) {}

  /** Active (not revoked) keys, newest first. Expired keys stay listed so they can be cleaned up. */
  async list(businessId: string): Promise<ApiKeyDto[]> {
    const rows = await prisma.apiKey.findMany({
      where: { businessId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.createdByUserId))] } },
      select: { id: true, email: true, name: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => this.serialize(r, byId.get(r.createdByUserId)));
  }

  async create(actor: BusinessContext, input: ApiKeyInput): Promise<ApiKeyCreatedDto> {
    if (actor.apiKeyId) {
      throw new ForbiddenException("API keys can't create other API keys — sign in to the dashboard instead");
    }
    const name = this.validName(input.name);
    const permissions = this.validPermissions(input.permissions);
    this.rolesService.assertActorCovers(actor, permissions);
    const expiresAt = this.validExpiry(input.expiresInDays);

    const active = await prisma.apiKey.count({ where: { businessId: actor.businessId, revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) {
      throw new BadRequestException(`A business can have at most ${MAX_ACTIVE_KEYS} API keys. Revoke one first.`);
    }

    const { key, prefix, keyHash } = generateApiKey();
    const row = await prisma.apiKey.create({
      data: {
        businessId: actor.businessId,
        name,
        prefix,
        keyHash,
        permissions,
        createdByUserId: actor.userId,
        expiresAt,
      },
    });
    const creator = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, email: true, name: true },
    });
    return { ...this.serialize(row, creator ?? undefined), key };
  }

  async revoke(businessId: string, id: string) {
    const { count } = await prisma.apiKey.updateMany({
      where: { id, businessId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException("API key not found");
  }

  private validName(value: unknown): string {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length < 2 || trimmed.length > 60) {
      throw new BadRequestException("name must be between 2 and 60 characters");
    }
    return trimmed;
  }

  private validPermissions(value: unknown): Permission[] {
    if (!Array.isArray(value) || value.length === 0 || !value.every((p) => typeof p === "string")) {
      throw new BadRequestException("permissions must be a non-empty array of permission strings");
    }
    const invalid = value.filter((p) => !isPermission(p));
    if (invalid.length > 0) {
      throw new BadRequestException(`Unknown permission(s): ${invalid.join(", ")}`);
    }
    const blocked = (value as Permission[]).filter((p) => NOT_GRANTABLE_TO_KEYS.includes(p));
    if (blocked.length > 0) {
      throw new BadRequestException(`API keys can't hold: ${blocked.join(", ")}`);
    }
    return [...new Set(value as Permission[])];
  }

  private validExpiry(value: unknown): Date | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_EXPIRY_DAYS) {
      throw new BadRequestException(`expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}, or null`);
    }
    return new Date(Date.now() + value * 24 * 60 * 60 * 1000);
  }

  private serialize(row: ApiKeyRow, creator?: { email: string; name: string | null }): ApiKeyDto {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      permissions: row.permissions.filter(isPermission),
      createdBy: { userId: row.createdByUserId, email: creator?.email, name: creator?.name ?? undefined },
      lastUsedAt: row.lastUsedAt?.toISOString(),
      expiresAt: row.expiresAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
