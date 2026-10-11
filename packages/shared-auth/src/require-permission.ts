import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  applyDecorators,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { BusinessContext, Permission } from "@platform/shared-types";
import { BusinessContextGuard } from "./business-context.guard";

const PERMISSIONS_KEY = "required_permissions";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const businessContext: BusinessContext | undefined = request.businessContext;
    if (!businessContext) {
      throw new UnauthorizedException("Business context required");
    }

    const granted = new Set(businessContext.permissions);
    const missing = required.filter((permission) => !granted.has(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission: ${missing.join(", ")}`);
    }
    return true;
  }
}

/**
 * Guards a route with the business JWT check + a permission check in one line:
 *
 *   @RequirePermission("members:invite")
 *   @Post()
 *   invite() { ... }
 */
export function RequirePermission(...permissions: Permission[]) {
  return applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    UseGuards(BusinessContextGuard, PermissionGuard),
  );
}
