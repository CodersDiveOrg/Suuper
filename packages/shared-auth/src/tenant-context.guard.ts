import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { TenantContext } from "@platform/shared-types";

/**
 * Verifies the bearer JWT and attaches a TenantContext to the request.
 * The API gateway is the only service exposed publicly; internal services
 * trust this same guard because gateway-issued JWTs are the only ones signed
 * with JWT_SECRET.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers["authorization"];
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const token = header.slice("Bearer ".length);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET ?? "dev-secret-change-me") as TenantContext;
      request.tenantContext = payload;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
