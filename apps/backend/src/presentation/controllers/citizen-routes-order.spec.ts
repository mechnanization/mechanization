import { PresentationModule } from '../presentation.module';
import { discoverRoutes, type DiscoveredRoute } from './route-discovery';

/**
 * Two controllers on one path, and the order Nest matches them in (audit GOD-13).
 *
 * `CitizenLandlordLinksController` and `CitizenController` are both mounted on
 * `t/:tenantSlug/citizens`. Nest registers routes controller by controller, in
 * `PresentationModule`'s order, and the first that matches answers: listed
 * after `CitizenController`, `GET citizens/landlord-links` would be
 * `getById` with «landlord-links» as the id, a 400 from `UuidPipe`. Within one
 * controller the rule is "static paths before `:id`"; across controllers it is
 * this, checked for every pair that shares a path.
 */
describe('controllers that share a path are registered so that no `:param` route swallows a later literal one', () => {
  const order = Reflect.getMetadata('controllers', PresentationModule) as DiscoveredRoute['controller'][];
  const routes = discoverRoutes();
  const segments = (path: string) => path.split('/').filter(Boolean);

  /** Whether `earlier`, matched first, answers a request meant for `later`. */
  const swallows = (earlier: DiscoveredRoute, later: DiscoveredRoute) => {
    if (earlier.method !== later.method) return false;
    const a = segments(earlier.path);
    const b = segments(later.path);
    if (a.length !== b.length) return false;
    let shadowsALiteral = false;
    for (const [index, segment] of a.entries()) {
      const theirs = b[index]!;
      if (segment.startsWith(':')) {
        if (!theirs.startsWith(':')) shadowsALiteral = true;
      } else if (segment !== theirs) {
        return false;
      }
    }
    return shadowsALiteral;
  };

  it('registers the owner-link routes before the citizen routes', () => {
    const names = order.map((controller) => controller.name);
    expect(names.indexOf('CitizenLandlordLinksController')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('CitizenLandlordLinksController')).toBeLessThan(names.indexOf('CitizenController'));
  });

  it('finds no route an earlier controller answers in place of a later one', () => {
    const clashes: string[] = [];
    for (const [i, first] of order.entries()) {
      for (const second of order.slice(i + 1)) {
        const earlier = routes.filter((route) => route.controller === first);
        const later = routes.filter((route) => route.controller === second);
        for (const e of earlier) {
          for (const l of later) {
            if (e.controllerPath === l.controllerPath && swallows(e, l)) clashes.push(`${e.name} answers ${l.name}`);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
