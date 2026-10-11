import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { ONBOARDING_STEPS, type BusinessProfile, type OnboardingStatus } from "@platform/shared-types";

const PROFILE_FIELDS = ["industry", "companySize", "website", "primaryGoal"] as const;
const MAX_PROFILE_FIELD = 200;

@Injectable()
export class OnboardingService {
  /** Step completion is derived from real data, so it stays correct however the user got there. */
  async status(businessId: string): Promise<OnboardingStatus> {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      include: {
        _count: {
          select: { memberships: true, integrationConnections: true, knowledgeBases: true, agents: true, bots: true },
        },
      },
    });
    if (!business) throw new NotFoundException("Business not found");

    const invitations = await prisma.invitation.count({
      where: { businessId, status: { in: ["pending", "accepted"] } },
    });
    const counts = business._count;
    const done: Record<(typeof ONBOARDING_STEPS)[number]["key"], boolean> = {
      profile: !!business.industry,
      team: counts.memberships > 1 || invitations > 0,
      integration: counts.integrationConnections > 0,
      knowledge: counts.knowledgeBases > 0,
      assistant: counts.agents + counts.bots > 0,
    };

    const steps = ONBOARDING_STEPS.map((s) => ({ key: s.key, done: done[s.key] }));
    const completedCount = steps.filter((s) => s.done).length;
    return {
      steps,
      completedCount,
      total: steps.length,
      completed: completedCount === steps.length,
      dismissed: !!business.onboardingDismissedAt,
      profile: this.toProfile(business),
    };
  }

  async updateProfile(businessId: string, input: Record<string, unknown>): Promise<BusinessProfile> {
    const data: Record<string, string | null> = {};

    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name.length < 2 || name.length > 80) {
        throw new BadRequestException("name must be between 2 and 80 characters");
      }
      data.name = name;
    }
    for (const field of PROFILE_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > MAX_PROFILE_FIELD) {
        throw new BadRequestException(`${field} must be a string under ${MAX_PROFILE_FIELD} characters`);
      }
      data[field] = value.trim() || null;
    }

    const business = await prisma.business.update({ where: { id: businessId }, data });
    return this.toProfile(business);
  }

  async setDismissed(businessId: string, dismissed: boolean) {
    await prisma.business.update({
      where: { id: businessId },
      data: { onboardingDismissedAt: dismissed ? new Date() : null },
    });
    return this.status(businessId);
  }

  private toProfile(business: {
    name: string;
    industry: string | null;
    companySize: string | null;
    website: string | null;
    primaryGoal: string | null;
  }): BusinessProfile {
    return {
      name: business.name,
      industry: business.industry ?? undefined,
      companySize: business.companySize ?? undefined,
      website: business.website ?? undefined,
      primaryGoal: business.primaryGoal ?? undefined,
    };
  }
}
