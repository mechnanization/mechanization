import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { StaffActor } from '../../application/common/actor';

/**
 * The staff member calling, as the services take it: `{ id, role }`.
 *
 * For a handler behind `@Roles(...)`, which `RolesGuard` has already limited to
 * staff holding a listed role. Anything else reaching it is a wiring bug, and
 * is thrown rather than passed on as staff with an empty role.
 */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): StaffActor => {
  // The global `Express.Request` (src/types/express.d.ts), so this file needs
  // no import of `express`, which the backend does not declare (DEAD-19).
  const request = context.switchToHttp().getRequest<Express.Request>();
  const user = request.user;
  if (!user) {
    throw new Error('CurrentActor used on a route that is not behind JwtAuthGuard');
  }
  if (user.kind !== 'STAFF' || !user.role) {
    // A `@SelfService` (or public) route asking for an actor: like `CurrentUser`
    // on a public route, a mistake in the code, not the caller's.
    throw new Error('CurrentActor used on a route that is not limited to staff by @Roles');
  }
  const { sub: id, role } = user;
  return { id, role };
});
