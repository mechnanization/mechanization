import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/*
  The route inventory: who can reach every route the API serves.

  `RolesGuard` admits any authenticated token — a citizen's too — to a route
  with no `@Roles` (docs/security.md, known gaps), and «مشاهد فقط» (VIEWER)
  writes nothing only because no write route lists it. Neither is something to
  trust to whoever adds the next endpoint, so both are checked here, over every
  controller found on disk rather than a hand-kept list: a new controller is
  covered the day it is written.
*/

type Route = {
  name: string;
  method: RequestMethod;
  path: string;
  isPublic: boolean;
  roles: readonly string[] | undefined;
};

/**
 * The routes with no `@Roles` that are not `@Public`, each reviewed: a
 * self-service route that checks `user.kind` and scopes by `user.sub` itself
 * (apps/backend/CLAUDE.md, Conventions). A role-less route not on this list
 * fails — give it `@Roles`, or review it and add it here with its reason.
 */
const SELF_SERVICE: Record<string, string> = {
  'AuthController.beginTotpEnrolment': "a staff member's own second factor",
  'AuthController.confirmTotpEnrolment': "a staff member's own second factor",
  'AuthController.disableTotp': "a staff member's own second factor",
  'AuthController.changePassword': "the caller's own password",
  'AuthController.changeEmail': "the caller's own email",
  'AuthController.sendResetPasswordEmail': "the caller's own reset email",
  'AuthController.me': 'who the caller is',
  'CadastreController.getAsset': 'the parcel map every signed-in screen draws',
  'CitizenController.mySummary': "a citizen's own summary; refuses staff",
  'FeesController.getSettings': "the municipality's payment instructions",
  'FeesController.mine': "a citizen's own bills; refuses staff",
  'FeesController.whishCheckout': "a citizen paying their own bill; refuses staff",
  'FeesController.declare': "a citizen declaring their own payment; refuses staff",
};

/**
 * GETs that change something, so they are not "reads" for the VIEWER rule.
 * `export.csv` writes a `report.exported` audit row and moves the register off
 * the system — the leader's account reads on screen and takes nothing away
 * (decision, 2026-10-05).
 */
const SIDE_EFFECT_GETS = ['DashboardController.exportCsv'];

function routes(): Route[] {
  const found: Route[] = [];
  for (const file of readdirSync(__dirname).filter((name) => name.endsWith('.controller.ts'))) {
    const mod = require(join(__dirname, file)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function' || Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
      const classRoles = Reflect.getMetadata(ROLES_KEY, exported) as string[] | undefined;
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, exported) as boolean | undefined;
      const prototype = (exported as { prototype: Record<string, unknown> }).prototype;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[key];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        found.push({
          name: `${(exported as { name: string }).name}.${key}`,
          method,
          path: String(Reflect.getMetadata(PATH_METADATA, handler)),
          isPublic: Boolean((Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined) ?? classPublic),
          roles: (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? classRoles,
        });
      }
    }
  }
  return found;
}

describe('the route inventory', () => {
  const all = routes();
  const roleLess = all.filter((route) => !route.isPublic && (!route.roles || route.roles.length === 0));

  it('finds every controller on disk', () => {
    expect(all.length).toBeGreaterThan(150);
    expect(new Set(all.map((route) => route.name.split('.')[0])).size).toBeGreaterThan(15);
  });

  it('gives every non-public route @Roles, unless it is a reviewed self-service route', () => {
    expect(roleLess.map((route) => route.name).filter((name) => !(name in SELF_SERVICE))).toEqual([]);
  });

  it('keeps the self-service list honest — every entry exists and is still role-less', () => {
    const roleLessNames = new Set(roleLess.map((route) => route.name));
    expect(Object.keys(SELF_SERVICE).filter((name) => !roleLessNames.has(name))).toEqual([]);
  });

  it('has no route that deletes a citizen — a citizen is archived, never deleted', () => {
    const deletes = all.filter(
      (route) => route.name.startsWith('CitizenController.') && route.method === RequestMethod.DELETE,
    );
    // Unlinking a landlord ends a link; it touches no citizen row.
    expect(deletes.map((route) => route.path)).toEqual(['landlord-links/:propertyEntryId']);
  });
});

describe('the «مشاهد فقط» (VIEWER) role — the municipality leader’s account', () => {
  const all = routes();
  const viewer = all.filter((route) => route.roles?.includes('VIEWER'));

  it('finds the routes to check', () => {
    expect(viewer.length).toBeGreaterThan(20);
  });

  it('is admitted to no write — and to no role-less route that writes', () => {
    const writes = viewer.filter((route) => route.method !== RequestMethod.GET).map((route) => route.name);
    expect(writes).toEqual([]);
    /*
      A role-less route admits VIEWER too. Every one that writes is a reviewed
      self-service route that refuses staff or touches only the caller's own
      account — which is what the self-service list above pins.
    */
  });

  it('is admitted to no GET that changes something, the register export first', () => {
    expect(viewer.filter((route) => SIDE_EFFECT_GETS.includes(route.name)).map((route) => route.name)).toEqual([]);
  });

  it('reads the dashboard, the reports, the register and its citizens, the census, cases and fees', () => {
    const names = new Set(viewer.map((route) => route.name));
    for (const name of [
      'DashboardController.counters',
      'DashboardController.analytics',
      'CitizenController.list',
      'CitizenController.getById',
      'CitizenController.reviewQueue',
      'BuildingsController.list',
      'BuildingsController.unsurveyedUnits',
      'BuildingsController.reinspections',
      'CasesController.list',
      'FeesController.summary',
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

/*
  The treasury's permission table (docs/finance.md §9), pinned route by route.
  A role list is the whole control on these handlers — the services trust the
  guard — so widening one must be a decision someone makes here, on purpose,
  not a side effect of an edit to a decorator.
*/
describe('the treasury routes (docs/finance.md §9)', () => {
  const READ = ['ACCOUNTANT', 'AUDITOR', 'SUPER_ADMIN', 'VIEWER'];
  const WORK = ['ACCOUNTANT', 'SUPER_ADMIN'];
  const ADMIN = ['SUPER_ADMIN'];
  const ALL_BUT_VIEWER = ['ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'AUDITOR', 'COLLECTOR', 'FIELD_INSPECTOR', 'SUPER_ADMIN'];
  const expected: Record<string, string[]> = {
    'TreasuryController.overview': READ,
    'TreasuryController.statement': READ,
    'TreasuryController.activate': ADMIN,
    'ExpensesController.categories': READ,
    'ExpensesController.createCategory': ADMIN,
    'ExpensesController.updateCategory': ADMIN,
    'ExpensesController.list': READ,
    'ExpensesController.get': READ,
    'ExpensesController.record': WORK,
    'ExpensesController.recordSalary': WORK,
    'ExpensesController.requests': READ,
    'ExpensesController.requestPayment': WORK,
    'ExpensesController.orderRequest': ADMIN,
    'ExpensesController.rejectRequest': ADMIN,
    'ExpensesController.withdrawRequest': WORK,
    'ExpensesController.regularize': ADMIN,
    'ExpensesController.void': ADMIN,
    'IncomeController.categories': READ,
    'IncomeController.createCategory': ADMIN,
    'IncomeController.updateCategory': ADMIN,
    'IncomeController.list': READ,
    'IncomeController.record': WORK,
    'IncomeController.get': READ,
    'IncomeController.void': ADMIN,
    'TransfersController.custody': READ,
    'TransfersController.myRound': ALL_BUT_VIEWER,
    'TransfersController.collections': READ,
    'TransfersController.list': READ,
    'TransfersController.receiveCustody': WORK,
    'TransfersController.void': ADMIN,
  };
  const treasury = routes().filter((route) => /^(Treasury|Expenses|Income|Transfers)Controller\./.test(route.name));

  it('knows every treasury handler, and no other', () => {
    expect(treasury.map((route) => route.name).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s admits exactly its roles', (name, roles) => {
    const route = treasury.find((candidate) => candidate.name === name);
    expect([...(route?.roles ?? [])].sort()).toEqual([...roles].sort());
  });

  it('lets no one but the manager order, refuse, regularise or cancel', () => {
    // `void` covers an expense, an income voucher and a transfer alike.
    const managerOnly = ['orderRequest', 'rejectRequest', 'regularize', 'void', 'activate'];
    const wider = treasury.filter(
      (route) => managerOnly.includes(route.name.split('.')[1]) && (route.roles ?? []).some((role) => role !== 'SUPER_ADMIN'),
    );
    expect(wider.map((route) => route.name)).toEqual([]);
  });
});
