import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { StaffRole } from '../../domain/entities/user.entity';
import { ForbiddenError } from '../../application/common/exceptions';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SELF_SERVICE_KEY } from '../decorators/self-service.decorator';

/**
 * Staff-only route protection. Runs after JwtAuthGuard, so the token is already
 * verified and its tenant already matched — this only decides authorisation.
 *
 * A citizen token reaching an admin route is rejected here on `kind` alone,
 * before roles are even considered: citizens have no role, and treating a
 * missing role as "no restrictions" is how these bugs happen.
 *
 * In order: `@Public()` admits; `@Roles(...)` admits staff holding a listed
 * role; `@SelfService(reason)` admits any authenticated caller, the handler
 * checking `kind` and scoping by `sub` itself; anything else is refused.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const required = this.reflector.getAllAndOverride<StaffRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      // Fails closed: a route that names no role must say it is self-service,
      // or nobody gets in. A forgotten `@Roles` is a 403 someone reports, not a
      // route a citizen token quietly reaches.
      const selfService = this.reflector.getAllAndOverride<string>(SELF_SERVICE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (typeof selfService === 'string' && selfService.length > 0) return true;
      throw new ForbiddenError('You do not have permission to perform this action');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user || user.kind !== 'STAFF') {
      throw new ForbiddenError('This action is restricted to municipality staff');
    }

    if (!user.role || !required.includes(user.role)) {
      throw new ForbiddenError('You do not have permission to perform this action');
    }

    return true;
  }
}
