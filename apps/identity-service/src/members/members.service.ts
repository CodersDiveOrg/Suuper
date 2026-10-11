import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { prisma } from "@platform/database";
import type { BusinessRole } from "@platform/shared-types";
import { RolesService, type RoleActor } from "../roles/roles.service";

type Actor = RoleActor & { userId: string };

@Injectable()
export class MembersService {
  constructor(private readonly rolesService: RolesService) {}

  async list(businessId: string) {
    const [memberships, roleNames] = await Promise.all([
      prisma.membership.findMany({
        where: { businessId },
        include: { user: true },
        orderBy: { createdAt: "asc" },
      }),
      this.rolesService.roleNames(businessId),
    ]);

    return memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name ?? undefined,
      role: m.role as BusinessRole,
      roleName: roleNames.get(m.role) ?? m.role,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  async changeRole(
    businessId: string,
    actor: Actor,
    targetUserId: string,
    newRole: string,
  ) {
    if (!newRole) {
      throw new BadRequestException("role is required");
    }
    const role = newRole as BusinessRole;

    const target = await this.requireMembership(businessId, targetUserId);
    const targetRole = target.role as BusinessRole;

    // The actor must be able to grant the new role, and must already cover
    // everything the member currently holds (no demoting someone above you).
    await this.rolesService.assertAssignable(businessId, actor, role);
    this.rolesService.assertActorCovers(actor, await this.rolesService.resolvePermissions(businessId, targetRole));

    // Only an owner may grant or revoke the owner role.
    if ((role === "owner" || targetRole === "owner") && actor.role !== "owner") {
      throw new ForbiddenException("Only an owner can change owner assignments");
    }

    if (targetRole === "owner" && role !== "owner") {
      await this.assertNotLastOwner(businessId, targetUserId);
    }

    if (role === targetRole) {
      return this.serialize(businessId, targetUserId);
    }

    await prisma.membership.update({
      where: { userId_businessId: { userId: targetUserId, businessId } },
      data: { role },
    });
    return this.serialize(businessId, targetUserId);
  }

  async remove(
    businessId: string,
    actor: Actor,
    targetUserId: string,
  ) {
    const target = await this.requireMembership(businessId, targetUserId);
    const targetRole = target.role as BusinessRole;
    this.rolesService.assertActorCovers(actor, await this.rolesService.resolvePermissions(businessId, targetRole));

    if (targetRole === "owner") {
      if (actor.role !== "owner") {
        throw new ForbiddenException("Only an owner can remove an owner");
      }
      await this.assertNotLastOwner(businessId, targetUserId);
    }

    await prisma.membership.delete({
      where: { userId_businessId: { userId: targetUserId, businessId } },
    });
  }

  private async requireMembership(businessId: string, userId: string) {
    const membership = await prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
    });
    if (!membership) {
      throw new NotFoundException("That user is not a member of this business");
    }
    return membership;
  }

  private async assertNotLastOwner(businessId: string, excludingUserId: string) {
    const otherOwners = await prisma.membership.count({
      where: { businessId, role: "owner", userId: { not: excludingUserId } },
    });
    if (otherOwners === 0) {
      throw new BadRequestException("A business must keep at least one owner");
    }
  }

  private async serialize(businessId: string, userId: string) {
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_businessId: { userId, businessId } },
      include: { user: true },
    });
    const roleNames = await this.rolesService.roleNames(businessId);
    return {
      userId: m.userId,
      email: m.user.email,
      name: m.user.name ?? undefined,
      role: m.role as BusinessRole,
      roleName: roleNames.get(m.role) ?? m.role,
      joinedAt: m.createdAt.toISOString(),
    };
  }
}
