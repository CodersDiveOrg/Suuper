import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { BusinessContext, UserContext } from "@platform/shared-types";
import { verifyBusinessToken, verifyUserToken } from "./jwt";

function bearer(request: { headers: Record<string, string | undefined> }): string {
  const header = request.headers["authorization"];
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedException("Missing bearer token");
  }
  return header.slice("Bearer ".length);
}

/**
 * Requires a business-scoped JWT and attaches a BusinessContext to the request.
 * Every route that acts inside a business uses this; the business id always
 * comes from the token, never from the client.
 */
@Injectable()
export class BusinessContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    try {
      const payload = verifyBusinessToken(bearer(request));
      const ctx: BusinessContext = {
        userId: payload.userId,
        businessId: payload.businessId,
        role: payload.role,
        permissions: payload.permissions,
      };
      request.businessContext = ctx;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired business token");
    }
  }
}

/**
 * Requires a plain user JWT (post-login, pre-business-selection) and attaches a
 * UserContext. Used by endpoints like "list my businesses" and "accept invite".
 */
@Injectable()
export class UserContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    try {
      const payload = verifyUserToken(bearer(request));
      const ctx: UserContext = { userId: payload.userId };
      request.userContext = ctx;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
