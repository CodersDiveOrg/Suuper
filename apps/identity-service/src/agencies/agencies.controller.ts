import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { UserContextGuard } from "@platform/shared-auth";
import { brandForHost, platformBrand, type ResolvedBrand } from "@platform/database";
import type { Brand, UserContext } from "@platform/shared-types";
import { AgenciesService } from "./agencies.service";

type Ctx = { userContext: UserContext };

// Agencies sit above businesses, so they use the user token (like GET
// /businesses); each route checks the caller is on the agency's team.
@Controller("agencies")
@UseGuards(UserContextGuard)
export class AgenciesController {
  constructor(private readonly agencies: AgenciesService) {}

  @Get()
  list(@Req() req: Ctx) {
    return this.agencies.listForUser(req.userContext.userId);
  }

  @Post()
  create(@Req() req: Ctx, @Body() body: { name?: unknown }) {
    return this.agencies.create(req.userContext.userId, body?.name);
  }

  @Get(":agencyId")
  detail(@Req() req: Ctx, @Param("agencyId") agencyId: string) {
    return this.agencies.detail(agencyId, req.userContext.userId);
  }

  @Patch(":agencyId")
  update(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Body() body: Record<string, unknown>) {
    return this.agencies.update(agencyId, req.userContext.userId, body ?? {});
  }

  @Patch(":agencyId/plan")
  setPlan(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Body() body: { plan?: unknown }) {
    return this.agencies.setPlan(agencyId, req.userContext.userId, body?.plan);
  }

  @Get(":agencyId/clients")
  clients(@Req() req: Ctx, @Param("agencyId") agencyId: string) {
    return this.agencies.clients(agencyId, req.userContext.userId);
  }

  @Post(":agencyId/clients")
  createClient(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Body() body: { name?: unknown; plan?: unknown; ownerEmail?: unknown }) {
    return this.agencies.createClient(agencyId, req.userContext.userId, body ?? {});
  }

  @Patch(":agencyId/clients/:businessId")
  updateClient(
    @Req() req: Ctx,
    @Param("agencyId") agencyId: string,
    @Param("businessId") businessId: string,
    @Body() body: { name?: unknown; plan?: unknown },
  ) {
    return this.agencies.updateClient(agencyId, req.userContext.userId, businessId, body ?? {});
  }

  @Delete(":agencyId/clients/:businessId")
  detachClient(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Param("businessId") businessId: string) {
    return this.agencies.detachClient(agencyId, req.userContext.userId, businessId);
  }

  @Post(":agencyId/clients/:businessId/resend-invite")
  @HttpCode(200)
  resendInvite(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Param("businessId") businessId: string) {
    return this.agencies.resendOwnerInvite(agencyId, req.userContext.userId, businessId);
  }

  @Get(":agencyId/members")
  members(@Req() req: Ctx, @Param("agencyId") agencyId: string) {
    return this.agencies.members(agencyId, req.userContext.userId);
  }

  @Post(":agencyId/members")
  addMember(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Body() body: { email?: unknown; role?: unknown }) {
    return this.agencies.addMember(agencyId, req.userContext.userId, body ?? {});
  }

  @Patch(":agencyId/members/:userId")
  changeRole(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Param("userId") userId: string, @Body() body: { role?: unknown }) {
    return this.agencies.changeMemberRole(agencyId, req.userContext.userId, userId, body?.role);
  }

  @Delete(":agencyId/members/:userId")
  removeMember(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Param("userId") userId: string) {
    return this.agencies.removeMember(agencyId, req.userContext.userId, userId);
  }

  @Put(":agencyId/domain")
  setDomain(@Req() req: Ctx, @Param("agencyId") agencyId: string, @Body() body: { domain?: unknown }) {
    return this.agencies.setDomain(agencyId, req.userContext.userId, body?.domain);
  }

  @Delete(":agencyId/domain")
  removeDomain(@Req() req: Ctx, @Param("agencyId") agencyId: string) {
    return this.agencies.removeDomain(agencyId, req.userContext.userId);
  }

  @Post(":agencyId/domain/verify")
  @HttpCode(200)
  verifyDomain(@Req() req: Ctx, @Param("agencyId") agencyId: string) {
    return this.agencies.verifyDomain(agencyId, req.userContext.userId);
  }
}

export function publicBrand(brand: ResolvedBrand): Brand {
  return {
    name: brand.name,
    logoUrl: brand.logoUrl,
    primaryColor: brand.primaryColor,
    supportEmail: brand.supportEmail,
    hidePoweredBy: brand.hidePoweredBy,
    agencyId: brand.agencyId,
  };
}

// Public: the web app asks which brand to show on the host it's served from,
// before anyone signs in. Only verified custom domains get an agency brand.
@Controller("branding")
export class BrandingController {
  @Get()
  async forHost(@Query("host") host?: string): Promise<Brand> {
    return publicBrand((await brandForHost(host)) ?? platformBrand());
  }
}
