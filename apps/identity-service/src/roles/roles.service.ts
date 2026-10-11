import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { prisma } from "@platform/database";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_INFO,
  type BusinessRole,
  type Permission,
  type RoleDto,
  isBuiltInRole,
  isPermission,
  permissionsForRole,
} from "@platform/shared-types";

const MAX_CUSTOM_ROLES = 50;

/** Who is performing a role-related change, from their business token. */
export interface RoleActor {
  role: BusinessRole;
  permissions: Permission[];
}

interface RoleInput {
  name?: string;
  description?: string;
  permissions?: unknown;
}

@Injectable()
export class RolesService {
  /** The permissions a role grants in a business — built-in map or the custom Role row. */
  async resolvePermissions(businessId: string, role: BusinessRole): Promise<Permission[]> {
    if (isBuiltInRole(role)) return permissionsForRole(role);
    const row = await prisma.role.findUnique({ where: { businessId_key: { businessId, key: role } } });
    return (row?.permissions ?? []).filter(isPermission);
  }

  /** Display name for a role key (falls back to the key for deleted custom roles). */
  async roleNames(businessId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>(BUILT_IN_ROLES.map((r) => [r, BUILT_IN_ROLE_INFO[r].name]));
    const custom = await prisma.role.findMany({ where: { businessId }, select: { key: true, name: true } });
    for (const r of custom) names.set(r.key, r.name);
    return names;
  }

  async list(businessId: string): Promise<RoleDto[]> {
    const [custom, counts] = await Promise.all([
      prisma.role.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } }),
      prisma.membership.groupBy({ by: ["role"], where: { businessId }, _count: { _all: true } }),
    ]);
    const memberCount = (key: string) => counts.find((c) => c.role === key)?._count._all ?? 0;

    return [
      ...BUILT_IN_ROLES.map((key) => ({
        key,
        ...BUILT_IN_ROLE_INFO[key],
        permissions: permissionsForRole(key),
        builtIn: true,
        memberCount: memberCount(key),
      })),
      ...custom.map((r) => this.serialize(r, memberCount(r.key))),
    ];
  }

  async create(businessId: string, actor: RoleActor, input: RoleInput): Promise<RoleDto> {
    const name = this.validName(input.name);
    const permissions = this.validPermissions(input.permissions);
    this.assertActorCovers(actor, permissions);

    const count = await prisma.role.count({ where: { businessId } });
    if (count >= MAX_CUSTOM_ROLES) {
      throw new BadRequestException(`A business can have at most ${MAX_CUSTOM_ROLES} custom roles`);
    }

    const key = await this.uniqueKey(businessId, name);
    const role = await prisma.role.create({
      data: { businessId, key, name, description: input.description?.trim() || null, permissions },
    });
    return this.serialize(role, 0);
  }

  async update(businessId: string, actor: RoleActor, key: string, input: RoleInput): Promise<RoleDto> {
    const existing = await this.requireCustom(businessId, key);
    this.assertActorCovers(actor, existing.permissions.filter(isPermission));

    const permissions = input.permissions === undefined ? undefined : this.validPermissions(input.permissions);
    if (permissions) this.assertActorCovers(actor, permissions);

    const role = await prisma.role.update({
      where: { id: existing.id },
      data: {
        name: input.name === undefined ? undefined : this.validName(input.name),
        description: input.description === undefined ? undefined : input.description.trim() || null,
        permissions,
      },
    });
    const memberCount = await prisma.membership.count({ where: { businessId, role: key } });
    return this.serialize(role, memberCount);
  }

  async remove(businessId: string, actor: RoleActor, key: string) {
    const existing = await this.requireCustom(businessId, key);
    this.assertActorCovers(actor, existing.permissions.filter(isPermission));

    const [members, invites] = await Promise.all([
      prisma.membership.count({ where: { businessId, role: key } }),
      prisma.invitation.count({ where: { businessId, role: key, status: "pending" } }),
    ]);
    if (members > 0 || invites > 0) {
      throw new ConflictException(
        `This role is still assigned to ${members} member(s) and ${invites} pending invite(s). Reassign them first.`,
      );
    }
    await prisma.role.delete({ where: { id: existing.id } });
  }

  /**
   * Checks the actor may hand out `roleKey`: the role must exist, only owners
   * grant owner, and nobody can grant permissions they don't hold themselves
   * (so a custom role can't be used to escalate).
   */
  async assertAssignable(businessId: string, actor: RoleActor, roleKey: string) {
    if (!isBuiltInRole(roleKey)) {
      const exists = await prisma.role.findUnique({ where: { businessId_key: { businessId, key: roleKey } } });
      if (!exists) throw new BadRequestException(`Unknown role: ${roleKey}`);
    }
    if (roleKey === "owner" && actor.role !== "owner") {
      throw new ForbiddenException("Only an owner can grant the owner role");
    }
    this.assertActorCovers(actor, await this.resolvePermissions(businessId, roleKey));
  }

  assertActorCovers(actor: RoleActor, permissions: Permission[]) {
    if (actor.role === "owner") return;
    const held = new Set(actor.permissions);
    const missing = permissions.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(`You can't grant permissions you don't have: ${missing.join(", ")}`);
    }
  }

  private async requireCustom(businessId: string, key: string) {
    if (isBuiltInRole(key)) {
      throw new BadRequestException("Built-in roles can't be changed");
    }
    const role = await prisma.role.findUnique({ where: { businessId_key: { businessId, key } } });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  private validName(name: string | undefined) {
    const trimmed = name?.trim() ?? "";
    if (trimmed.length < 2 || trimmed.length > 40) {
      throw new BadRequestException("name must be between 2 and 40 characters");
    }
    return trimmed;
  }

  private validPermissions(value: unknown): Permission[] {
    if (!Array.isArray(value) || !value.every((p) => typeof p === "string")) {
      throw new BadRequestException("permissions must be an array of permission strings");
    }
    const invalid = value.filter((p) => !isPermission(p));
    if (invalid.length > 0) {
      throw new BadRequestException(`Unknown permission(s): ${invalid.join(", ")}`);
    }
    return [...new Set(value as Permission[])];
  }

  private async uniqueKey(businessId: string, name: string) {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "role";
    for (let attempt = 0; attempt < MAX_CUSTOM_ROLES + BUILT_IN_ROLES.length; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      if (isBuiltInRole(candidate)) continue;
      const taken = await prisma.role.findUnique({ where: { businessId_key: { businessId, key: candidate } } });
      if (!taken) return candidate;
    }
    throw new BadRequestException("Could not generate a unique key for that role name");
  }

  private serialize(
    role: { id: string; key: string; name: string; description: string | null; permissions: string[]; createdAt: Date },
    memberCount: number,
  ): RoleDto {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description ?? undefined,
      permissions: role.permissions.filter(isPermission),
      builtIn: false,
      memberCount,
      createdAt: role.createdAt.toISOString(),
    };
  }
}
