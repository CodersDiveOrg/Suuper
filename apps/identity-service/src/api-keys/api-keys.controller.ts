import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { ApiKeysService } from "./api-keys.service";

interface ApiKeyBody {
  name?: unknown;
  permissions?: unknown;
  expiresInDays?: unknown;
}

// Business comes from the token, so the path is fixed at "current".
@Controller("businesses/current/api-keys")
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Get()
  @RequirePermission("apikeys:manage")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.apiKeysService.list(request.businessContext.businessId);
  }

  /** The response carries the raw key — the only time it's ever returned. */
  @Post()
  @RequirePermission("apikeys:manage")
  async create(@Req() request: { businessContext: BusinessContext }, @Body() body: ApiKeyBody) {
    return this.apiKeysService.create(request.businessContext, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("apikeys:manage")
  async revoke(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.apiKeysService.revoke(request.businessContext.businessId, id);
  }
}
