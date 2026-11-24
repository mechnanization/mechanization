import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SELF_SERVICE_KEY } from '../decorators/self-service.decorator';

/**
 * Every route the API serves, read off the controllers on disk.
 *
 * For the specs that hold a property over *every* route — who may call it
 * (`route-inventory.spec.ts`), and that another municipality's token is refused
 * on it (`cross-tenant-routes.spec.ts`). Read from disk rather than a
 * hand-kept list, so a new controller is covered the day it is written. Test
 * code: nothing in the running API imports it.
 */
export type DiscoveredRoute = {
  /** `Controller.handler`. */
  name: string;
  /** The controller class, to ask whether a module registers it. */
  controller: abstract new (...args: never[]) => unknown;
  method: RequestMethod;
  /** The controller's own path, `t/:tenantSlug/fees`. */
  controllerPath: string;
  /** The handler's path under it, `notices/:id/cancel`. */
  path: string;
  isPublic: boolean;
  roles: readonly string[] | undefined;
  /** The reason given to `@SelfService(...)`, when the route carries it. */
  selfService: string | undefined;
  /** The handler function, for any further metadata a spec reads. */
  handler: (...args: unknown[]) => unknown;
};

export function discoverRoutes(): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  for (const file of readdirSync(__dirname).filter((name) => name.endsWith('.controller.ts'))) {
    // Each controller module is loaded by its file name, synchronously, because
    // `route-inventory.spec.ts` reads the list in `describe` bodies. The rule is
    // off for specs, where this loop lived until it was shared; this is test code.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(__dirname, file)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function' || Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
      const classRoles = Reflect.getMetadata(ROLES_KEY, exported) as string[] | undefined;
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, exported) as boolean | undefined;
      const classSelfService = Reflect.getMetadata(SELF_SERVICE_KEY, exported) as string | undefined;
      const controllerPath = String(Reflect.getMetadata(PATH_METADATA, exported));
      const prototype = (exported as { prototype: Record<string, unknown> }).prototype;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[key];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        found.push({
          name: `${(exported as { name: string }).name}.${key}`,
          controller: exported as DiscoveredRoute['controller'],
          method,
          controllerPath,
          path: String(Reflect.getMetadata(PATH_METADATA, handler)),
          isPublic: Boolean((Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined) ?? classPublic),
          roles: (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? classRoles,
          selfService: (Reflect.getMetadata(SELF_SERVICE_KEY, handler) as string | undefined) ?? classSelfService,
          handler: handler as (...args: unknown[]) => unknown,
        });
      }
    }
  }
  return found;
}
