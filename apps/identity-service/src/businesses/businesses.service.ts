import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import type { BusinessRole } from "@platform/shared-types";
import { RolesService } from "../roles/roles.service";

const MAX_SLUG_ATTEMPTS = 20;

@Injectable()
export class BusinessesService {
  constructor(private readonly rolesService: RolesService) {}

  /** Self-serve creation: the caller becomes the business's first owner. */
  async create(userId: string, name: string) {
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 80) {
      throw new BadRequestException("name must be between 2 and 80 characters");
    }

    const slug = await this.uniqueSlug(trimmedName);

    const business = await prisma.$transaction(async (tx) => {
      const created = await tx.business.create({ data: { name: trimmedName, slug } });
      await tx.membership.create({
        data: { userId, businessId: created.id, role: "owner" },
      });
      return created;
    });

    return {
      id: business.id,
      name: business.name,
      slug: business.slug,
      role: "owner" as BusinessRole,
    };
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "business";

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await prisma.business.findUnique({ where: { slug: candidate } });
      if (!existing) {
        return candidate;
      }
    }
    throw new BadRequestException("Could not generate a unique slug for that name");
  }

  async listForUser(userId: string) {
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

  /** Details of the business the caller is currently acting in. */
  async current(businessId: string, role: BusinessRole) {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      include: { _count: { select: { memberships: true } } },
    });
    if (!business) {
      throw new NotFoundException("Business not found");
    }

    return {
      id: business.id,
      name: business.name,
      slug: business.slug,
      isolationTier: business.isolationTier,
      createdAt: business.createdAt.toISOString(),
      memberCount: business._count.memberships,
      role,
      permissions: await this.rolesService.resolvePermissions(businessId, role),
    };
  }
}
