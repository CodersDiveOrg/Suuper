import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Req,
} from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { MembersService } from "./members.service";

interface ChangeRoleBody {
  role?: string;
}

// Business comes from the token, so the path is fixed at "current".
@Controller("businesses/current/members")
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @RequirePermission("members:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.membersService.list(request.businessContext.businessId);
  }

  @Patch(":userId")
  @RequirePermission("members:manage")
  async changeRole(
    @Req() request: { businessContext: BusinessContext },
    @Param("userId") userId: string,
    @Body() body: ChangeRoleBody,
  ) {
    const { businessId, userId: actorUserId, role, permissions } = request.businessContext;
    return this.membersService.changeRole(
      businessId,
      { userId: actorUserId, role, permissions },
      userId,
      body.role ?? "",
    );
  }

  @Delete(":userId")
  @HttpCode(204)
  @RequirePermission("members:manage")
  async remove(
    @Req() request: { businessContext: BusinessContext },
    @Param("userId") userId: string,
  ) {
    const { businessId, userId: actorUserId, role, permissions } = request.businessContext;
    await this.membersService.remove(businessId, { userId: actorUserId, role, permissions }, userId);
  }
}
