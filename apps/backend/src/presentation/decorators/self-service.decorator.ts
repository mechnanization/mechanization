import { SetMetadata } from '@nestjs/common';

export const SELF_SERVICE_KEY = 'selfService';

/**
 * Admits any authenticated caller, staff or citizen, to a route with no `@Roles`.
 *
 * `RolesGuard` refuses a non-public route that declares neither `@Roles` nor
 * this, so leaving a role off fails closed. A route marked self-service is the
 * caller acting on their own record: it checks `user.kind` itself and scopes
 * every query by `user.sub` (apps/backend/CLAUDE.md, Conventions). The reason
 * is kept as metadata, and `route-inventory.spec.ts` pins every marked route to
 * its reviewed entry, so a new one is a reviewed change, not a quiet one.
 */
export const SelfService = (reason: string) => SetMetadata(SELF_SERVICE_KEY, reason);
