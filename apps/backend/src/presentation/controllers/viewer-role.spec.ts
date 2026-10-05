import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../decorators/roles.decorator';
import * as audit from './audit.controller';
import * as backup from './backup.controller';
import * as buildings from './buildings.controller';
import * as cadastre from './cadastre.controller';
import * as cases from './cases.controller';
import * as citizen from './citizen.controller';
import * as corrections from './corrections.controller';
import * as dashboard from './dashboard.controller';
import * as document from './document.controller';
import * as fees from './fees.controller';
import * as quality from './quality.controller';
import * as registration from './registration.controller';
import * as staff from './staff.controller';
import * as tenant from './tenant.controller';
import * as zones from './zones.controller';

/*
  «مشاهد فقط» writes nothing, and the only thing that makes that true is the
  `@Roles` on every route — there is no other layer. So it is checked here,
  route by route, rather than trusted to whoever adds the next endpoint: a
  write route that lists VIEWER fails this test.
*/

type Route = { name: string; method: RequestMethod; roles: readonly string[] | undefined };

const MODULES = [
  audit, backup, buildings, cadastre, cases, citizen, corrections, dashboard,
  document, fees, quality, registration, staff, tenant, zones,
];

function routes(): Route[] {
  const found: Route[] = [];
  for (const mod of MODULES) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function' || Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
      const classRoles = Reflect.getMetadata(ROLES_KEY, exported) as string[] | undefined;
      for (const key of Object.getOwnPropertyNames(exported.prototype)) {
        const handler = exported.prototype[key];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        found.push({
          name: `${exported.name}.${key}`,
          method,
          roles: (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? classRoles,
        });
      }
    }
  }
  return found;
}

describe('the «مشاهد فقط» (VIEWER) role', () => {
  const all = routes();
  const viewer = all.filter((route) => route.roles?.includes('VIEWER'));

  it('finds the routes to check', () => {
    expect(all.length).toBeGreaterThan(100);
    expect(viewer.length).toBeGreaterThan(20);
  });

  it('is admitted only to reads', () => {
    const writes = viewer.filter((route) => route.method !== RequestMethod.GET).map((route) => route.name);
    expect(writes).toEqual([]);
  });

  it('reads the register, the census, cases, reports and fees', () => {
    const names = new Set(viewer.map((route) => route.name));
    for (const name of [
      'CitizenController.list',
      'CitizenController.reviewQueue',
      'BuildingsController.list',
      'BuildingsController.unsurveyedUnits',
      'CasesController.list',
      'DashboardController.counters',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('is not admitted to the audit trail, staff, quality decisions, settings or identity documents', () => {
    const forbidden = viewer.filter((route) =>
      /^(AuditController|StaffController|QualityController|BackupController|TenantController|DocumentController|CorrectionsController|CadastreController)\./.test(
        route.name,
      ),
    );
    expect(forbidden.map((route) => route.name)).toEqual([]);
  });
});
