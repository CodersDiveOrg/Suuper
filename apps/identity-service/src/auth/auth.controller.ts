import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserContextGuard } from "@platform/shared-auth";
import type { UserContext } from "@platform/shared-types";
import { AuthService } from "./auth.service";
import { requestOrigin } from "@platform/database";

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
  async login(@Body() body: LoginBody, @Headers("origin") origin?: string) {
    if (!body.email || !body.password) {
      throw new BadRequestException("Email and password are required");
    }
    return this.authService.login(body.email, body.password, origin);
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
  async resendLoginCode(@Body() body: { challengeId?: string }, @Headers("origin") origin?: string) {
    if (!body.challengeId) {
      throw new BadRequestException("challengeId is required");
    }
    return this.authService.resendLoginCode(body.challengeId, origin);
  }

  /** Sign in or sign up with Google: `credential` is the ID token from "Sign in with Google". */
  @Post("google")
  async googleSignIn(@Body() body: { credential?: string }) {
    if (!body.credential) {
      throw new BadRequestException("credential is required");
    }
    return this.authService.googleSignIn(body.credential);
  }

  /** Forgot password, step 1: email a reset code (same response whether or not the account exists). */
  @Post("password/forgot")
  async forgotPassword(@Body() body: { email?: string }, @Headers("origin") origin?: string) {
    if (!body.email?.trim()) {
      throw new BadRequestException("Email is required");
    }
    return this.authService.forgotPassword(body.email, origin);
  }

  /** Forgot password, step 2: the emailed code plus the new password. */
  @Post("password/reset")
  async resetPassword(@Body() body: { challengeId?: string; code?: string; password?: string }) {
    if (!body.challengeId || !body.code) {
      throw new BadRequestException("challengeId and code are required");
    }
    if (!body.password || body.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }
    return this.authService.resetPassword(body.challengeId, body.code, body.password);
  }

  @Post("password/resend")
  async resendPasswordResetCode(@Body() body: { challengeId?: string }, @Headers("origin") origin?: string) {
    if (!body.challengeId) {
      throw new BadRequestException("challengeId is required");
    }
    return this.authService.resendPasswordResetCode(body.challengeId, origin);
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
    @Req() request: { userContext: UserContext; headers: Record<string, string | string[] | undefined>; ip?: string },
    @Param("businessId") businessId: string,
  ) {
    return this.authService.createBusinessSession(request.userContext.userId, businessId, requestOrigin(request));
  }
}
