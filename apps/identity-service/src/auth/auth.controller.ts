import { Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { TenantContextGuard } from "@platform/shared-auth";
import type { TenantContext } from "@platform/shared-types";
import { AuthService } from "./auth.service";

interface LoginBody {
  email?: string;
  password?: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  async login(@Body() body: LoginBody) {
    if (!body.email || !body.password) {
      throw new UnauthorizedException("Email and password are required");
    }
    return this.authService.login(body.email, body.password);
  }

  @Get("me")
  @UseGuards(TenantContextGuard)
  async me(@Req() request: { tenantContext: TenantContext }) {
    const { userId, tenantId } = request.tenantContext;
    return this.authService.me(userId, tenantId);
  }
}
