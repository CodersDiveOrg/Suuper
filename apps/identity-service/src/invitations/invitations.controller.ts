import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { RequirePermission, UserContextGuard } from "@platform/shared-auth";
import type { BusinessContext, UserContext } from "@platform/shared-types";
import { InvitationsService } from "./invitations.service";

interface CreateInvitationBody {
  email?: string;
  role?: string;
}

@Controller("businesses/current/invitations")
export class BusinessInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @RequirePermission("members:invite")
  async create(
    @Req() request: { businessContext: BusinessContext },
    @Body() body: CreateInvitationBody,
  ) {
    const { businessId, userId, role, permissions } = request.businessContext;
    return this.invitationsService.create(
      businessId,
      userId,
      { role, permissions },
      body.email ?? "",
      body.role ?? "member",
    );
  }

  @Get()
  @RequirePermission("members:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.invitationsService.listPending(request.businessContext.businessId);
  }

  /** New link + expiry, re-emailed. The old link stops working. */
  @Post(":id/resend")
  @RequirePermission("members:invite")
  async resend(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    const { businessId, userId, role, permissions } = request.businessContext;
    return this.invitationsService.resend(businessId, { userId, role, permissions }, id);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("members:invite")
  async revoke(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
  ) {
    await this.invitationsService.revoke(request.businessContext.businessId, id);
  }
}

@Controller("invitations")
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  /** Unauthenticated preview so the accept screen can show the business name. */
  @Get(":token")
  async preview(@Param("token") token: string) {
    return this.invitationsService.preview(token);
  }

  @Post("accept")
  @UseGuards(UserContextGuard)
  async accept(
    @Req() request: { userContext: UserContext },
    @Body() body: { token?: string },
  ) {
    if (!body.token) {
      throw new BadRequestException("token is required");
    }
    return this.invitationsService.accept(body.token, request.userContext.userId);
  }

  /** No account yet: create one from the invitation and join in one step. */
  @Post(":token/register")
  async register(@Param("token") token: string, @Body() body: { name?: string; password?: string }) {
    return this.invitationsService.registerAndAccept(token, body);
  }
}
