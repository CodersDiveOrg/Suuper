import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserContextGuard } from "@platform/shared-auth";
import type { UserContext } from "@platform/shared-types";
import { AuthService } from "./auth.service";

interface RegisterBody {
  email?: string;
  password?: string;
  name?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
}

interface VerifyLoginBody {
  challengeId?: string;
  code?: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  async register(@Body() body: RegisterBody) {
    if (!body.email || !body.password) {
      throw new BadRequestException("Email and password are required");
    }
    if (body.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }
    return this.authService.register(body.email, body.password, body.name);
  }

  @Post("login")
  async login(@Body() body: LoginBody) {
    if (!body.email || !body.password) {
      throw new BadRequestException("Email and password are required");
    }
    return this.authService.login(body.email, body.password);
  }

  /** Second step: exchange the emailed code for a user token. */
  @Post("login/verify")
  async verifyLogin(@Body() body: VerifyLoginBody) {
    if (!body.challengeId || !body.code) {
      throw new BadRequestException("challengeId and code are required");
    }
    return this.authService.verifyLoginCode(body.challengeId, body.code);
  }

  @Post("login/resend")
  async resendLoginCode(@Body() body: { challengeId?: string }) {
    if (!body.challengeId) {
      throw new BadRequestException("challengeId is required");
    }
    return this.authService.resendLoginCode(body.challengeId);
  }

  @Get("me")
  @UseGuards(UserContextGuard)
  async me(@Req() request: { userContext: UserContext }) {
    return this.authService.me(request.userContext.userId);
  }

  /** Pick which business to act in; returns a business-scoped access token. */
  @Post("businesses/:businessId/session")
  @UseGuards(UserContextGuard)
  async createBusinessSession(
    @Req() request: { userContext: UserContext },
    @Param("businessId") businessId: string,
  ) {
    return this.authService.createBusinessSession(request.userContext.userId, businessId);
  }
}
