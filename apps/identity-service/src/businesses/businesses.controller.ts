import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { BusinessContextGuard, UserContextGuard } from "@platform/shared-auth";
import type { BusinessContext, UserContext } from "@platform/shared-types";
import { BusinessesService } from "./businesses.service";

interface CreateBusinessBody {
  name?: string;
}

@Controller("businesses")
export class BusinessesController {
  constructor(private readonly businessesService: BusinessesService) {}

  /** Every business the current user is a member of. */
  @Get()
  @UseGuards(UserContextGuard)
  async list(@Req() request: { userContext: UserContext }) {
    return this.businessesService.listForUser(request.userContext.userId);
  }

  /** Self-serve creation: any logged-in user can start a business and becomes its owner. */
  @Post()
  @UseGuards(UserContextGuard)
  async create(
    @Req() request: { userContext: UserContext },
    @Body() body: CreateBusinessBody,
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException("name is required");
    }
    return this.businessesService.create(request.userContext.userId, body.name);
  }

  /** The business named by the current business-scoped token. */
  @Get("current")
  @UseGuards(BusinessContextGuard)
  async current(@Req() request: { businessContext: BusinessContext }) {
    const { businessId, role } = request.businessContext;
    return this.businessesService.current(businessId, role);
  }
}
