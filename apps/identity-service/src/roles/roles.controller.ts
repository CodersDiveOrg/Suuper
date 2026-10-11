import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { RolesService } from "./roles.service";

interface RoleBody {
  name?: string;
  description?: string;
  permissions?: unknown;
}

// Business comes from the token, so the path is fixed at "current".
@Controller("businesses/current/roles")
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  /** Built-in + custom roles. Readable by anyone who can see members, so role pickers work. */
  @Get()
  @RequirePermission("members:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.rolesService.list(request.businessContext.businessId);
  }

  @Post()
  @RequirePermission("roles:manage")
  async create(@Req() request: { businessContext: BusinessContext }, @Body() body: RoleBody) {
    const { businessId, role, permissions } = request.businessContext;
    return this.rolesService.create(businessId, { role, permissions }, body);
  }

  @Patch(":key")
  @RequirePermission("roles:manage")
  async update(
    @Req() request: { businessContext: BusinessContext },
    @Param("key") key: string,
    @Body() body: RoleBody,
  ) {
    const { businessId, role, permissions } = request.businessContext;
    return this.rolesService.update(businessId, { role, permissions }, key, body);
  }

  @Delete(":key")
  @HttpCode(204)
  @RequirePermission("roles:manage")
  async remove(@Req() request: { businessContext: BusinessContext }, @Param("key") key: string) {
    const { businessId, role, permissions } = request.businessContext;
    await this.rolesService.remove(businessId, { role, permissions }, key);
  }
}
