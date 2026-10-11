import { Body, Controller, Get, Patch, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { OnboardingService } from "./onboarding.service";

// Business comes from the token, so the paths are fixed at "current".
@Controller("businesses/current")
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get("onboarding")
  @RequirePermission("business:read")
  async status(@Req() request: { businessContext: BusinessContext }) {
    return this.onboardingService.status(request.businessContext.businessId);
  }

  /** Hide (or re-show) the getting-started checklist for everyone in the business. */
  @Post("onboarding/dismiss")
  @RequirePermission("business:manage")
  async dismiss(@Req() request: { businessContext: BusinessContext }, @Body() body: { dismissed?: boolean }) {
    return this.onboardingService.setDismissed(request.businessContext.businessId, body.dismissed !== false);
  }

  @Patch("profile")
  @RequirePermission("business:manage")
  async updateProfile(
    @Req() request: { businessContext: BusinessContext },
    @Body() body: Record<string, unknown>,
  ) {
    return this.onboardingService.updateProfile(request.businessContext.businessId, body ?? {});
  }
}
