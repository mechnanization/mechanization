import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Param, ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { FeesController } from './fees.controller';

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
  The ids the fee routes take from their path. Each reaches the ledger only
  once it parses as a UUID — a malformed one becomes a raw database error, a
  500 and a Sentry event. Every one is checked here, found from the
  controller's own metadata rather than from a list, so a fee route added
  tomorrow is covered the day it is written. «عكس الوصل»'s two are also checked
  by name: the receipts of one bill, and reversing one of them. Who may reverse
  is pinned with the other fee routes that move treasury money, below
  (`FeesController.reverseTransaction`).

  Eight of them took their id raw on `develop`. They carry PR #120's own line
  for each (its B9), word for word, so the two branches agree on every one
  (docs/finance.md §14, review of PR #113).

  Nest takes a pipe as an instance (`new ParseUUIDPipe()`, the house form) or
  as the class itself (`ParseUUIDPipe`, which it instantiates); both validate,
  so both pass here.
*/
describe('the ids the fee routes take from their path', () => {
  type RouteArg = { data?: unknown; pipes?: unknown[] };
  const argsOf = (controller: object, method: string): Array<[string, RouteArg]> =>
    Object.entries((Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, RouteArg>);
  const pipesOn = (controller: object, method: string, param: string): unknown[] =>
    argsOf(controller, method).find(([, arg]) => arg.data === param)?.[1].pipes ?? [];
  const checksUuid = (pipes: unknown[]): boolean =>
    pipes.some((pipe) => pipe === ParseUUIDPipe || pipe instanceof ParseUUIDPipe);

  /** Every path parameter of a FeesController route that names an id (`id`, or a name ending in `Id`). */
  const feeIds = Object.getOwnPropertyNames(FeesController.prototype)
    .filter((method) => {
      const handler: unknown = Object.getOwnPropertyDescriptor(FeesController.prototype, method)?.value;
      return typeof handler === 'function' && Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
    })
    .flatMap((method) =>
      argsOf(FeesController, method)
        .filter(([key, arg]) => key.startsWith(`${RouteParamtypes.PARAM}:`) && /^(id|\w+Id)$/.test(String(arg.data)))
        .map(([, arg]) => ({ name: `FeesController.${method}(${String(arg.data)})`, checked: checksUuid(arg.pipes ?? []) })),
    );

  it('finds them, so the checks below are about something', () => {
    expect(feeIds.length).toBeGreaterThanOrEqual(11);
    // A staff route, a citizen's own route whose id follows `tenantSlug`, and an id not named `id`.
    expect(feeIds.map((id) => id.name)).toEqual(
      expect.arrayContaining([
        'FeesController.getPayment(id)',
        'FeesController.whishCheckout(id)',
        'FeesController.reverseTransaction(transactionId)',
      ]),
    );
  });

  it.each([
    ['transactions', 'id'],
    ['reverseTransaction', 'transactionId'],
  ])('checks the %s id (%s) is a UUID', (method, param) => {
    expect(checksUuid(pipesOn(FeesController, method, param))).toBe(true);
  });

  it('checks every id a fee route takes from its path is a UUID', () => {
    expect(feeIds.filter((id) => !id.checked).map((id) => id.name)).toEqual([]);
  });

  it('counts the pipe in either form Nest takes, and an id without it as unchecked', () => {
    class Probe {
      instance(@Param('id', new ParseUUIDPipe()) id: string) {
        return id;
      }
      asClass(@Param('id', ParseUUIDPipe) id: string) {
        return id;
      }
      unchecked(@Param('id') id: string) {
        return id;
      }
    }
    expect(['instance', 'asClass', 'unchecked'].map((method) => checksUuid(pipesOn(Probe, method, 'id')))).toEqual([
      true,
      true,
      false,
    ]);
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
  // Who clears a flagged exchange (§6.3): the auditor and the manager, never the accountant who booked it.
  const REVIEW = ['AUDITOR', 'SUPER_ADMIN'];
  const ALL_BUT_VIEWER = ['ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'AUDITOR', 'COLLECTOR', 'FIELD_INSPECTOR', 'SUPER_ADMIN'];
  const expected: Record<string, string[]> = {
    'TreasuryController.overview': READ,
    'TreasuryController.statement': READ,
    'TreasuryController.activate': ADMIN,
    // «إضافة حساب» (§6.4): a wallet is opened by the manager alone.
    'TreasuryController.createAccount': ADMIN,
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
    // Stage 4 (§6): an internal transfer or an exchange is work; its slip is read; its review is the auditor's.
    'TransfersController.create': WORK,
    'TransfersController.get': READ,
    'TransfersController.review': REVIEW,
    // Stage 5 (§7): the sheet, the history and the report are read; counting and closing are work;
    // reopening a closed day is the manager's alone.
    'TreasuryClosingController.sheet': READ,
    'TreasuryClosingController.history': READ,
    'TreasuryClosingController.daily': READ,
    'TreasuryClosingController.record': WORK,
    'TreasuryClosingController.close': WORK,
    'TreasuryClosingController.reopen': ADMIN,
    // «صرف عمولة» (§5.6): a «PV-» voucher and a ledger debit once live. Paid like a salary (D9):
    // the accountant's on the urgent path, waiting for the manager's order.
    'StaffController.recordPayout': WORK,
    /*
      The fee routes that post wallet entries once the treasury is live (§3.3, §3.4): a counter
      or collector payment credits a safe or a custody wallet (`settleInPerson`), confirming a
      Whish transfer credits the Whish wallet (`review`), and reversing a receipt takes the money
      back out (`reverseTransaction`). Their lists are the fee sets the screens read
      (`FEE_ISSUE_ROLES`, `FEE_ADMIN_ROLES`, `PAYMENT_REVERSE_ROLES`), pinned here so that
      widening one — an administrative officer at the counter — fails CI rather than passing
      unseen.
    */
    'FeesController.settle': ['ACCOUNTANT', 'COLLECTOR', 'SUPER_ADMIN'],
    'FeesController.review': WORK,
    'FeesController.reverseTransaction': ADMIN,
    // Whish's own callback: no session and no role — `@Public()`, checked by the HMAC over its body.
    'FeesController.whishCallback': [],
  };
  /*
    Every treasury controller by name: a new one is added here, or its handlers are pinned by
    nothing. And, by name, each handler elsewhere that moves treasury money; the bulk settlement's
    two are pinned in their own block below.
  */
  const MONEY_HANDLERS_ELSEWHERE = [
    'StaffController.recordPayout',
    'FeesController.settle',
    'FeesController.review',
    'FeesController.reverseTransaction',
    'FeesController.whishCallback',
  ];
  const treasury = routes().filter(
    (route) =>
      /^(Treasury|TreasuryClosing|Expenses|Income|Transfers)Controller\./.test(route.name) ||
      MONEY_HANDLERS_ELSEWHERE.includes(route.name),
  );

  it('knows every treasury handler, and no other', () => {
    expect(treasury.map((route) => route.name).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s admits exactly its roles', (name, roles) => {
    const route = treasury.find((candidate) => candidate.name === name);
    expect([...(route?.roles ?? [])].sort()).toEqual([...roles].sort());
  });

  it('lets no one but the manager order, refuse, regularise, cancel, reopen a closed day or open a wallet', () => {
    // `void` covers an expense, an income voucher and a transfer alike.
    const managerOnly = ['orderRequest', 'rejectRequest', 'regularize', 'void', 'activate', 'reopen', 'createAccount'];
    const wider = treasury.filter(
      (route) => managerOnly.includes(route.name.split('.')[1]) && (route.roles ?? []).some((role) => role !== 'SUPER_ADMIN'),
    );
    expect(wider.map((route) => route.name)).toEqual([]);
  });

  it('never lets the accountant, who books an exchange, clear its review', () => {
    const route = treasury.find((candidate) => candidate.name === 'TransfersController.review');
    expect(route?.roles ?? []).not.toContain('ACCOUNTANT');
  });
});

/*
  «تسديد الفواتير المحددة» (docs/finance.md §3.7), pinned as the treasury's
  routes are: it moves money for up to fifty bills in one press, and the role
  list is the whole control on who may press it. A collector settles the same
  bills one at a time; widening this is a decision, not an edit.
*/
describe('the bulk settlement routes (docs/finance.md §3.7)', () => {
  const expected: Record<string, string[]> = {
    'FeesController.bulkSettle': ['ACCOUNTANT', 'SUPER_ADMIN'],
    'FeesController.settlement': ['ACCOUNTANT', 'ADMINISTRATIVE_OFFICER', 'AUDITOR', 'COLLECTOR', 'SUPER_ADMIN', 'VIEWER'],
  };
  const all = routes();

  it.each(Object.entries(expected))('%s admits exactly its roles', (name, roles) => {
    const route = all.find((candidate) => candidate.name === name);
    expect(route).toBeDefined();
    expect([...(route?.roles ?? [])].sort()).toEqual([...roles].sort());
  });

  it('serves the settle as a POST and the reprint as a GET', () => {
    const settle = all.find((route) => route.name === 'FeesController.bulkSettle');
    const reprint = all.find((route) => route.name === 'FeesController.settlement');
    expect([settle?.method, settle?.path]).toEqual([RequestMethod.POST, 'payments/bulk-settle']);
    expect([reprint?.method, reprint?.path]).toEqual([RequestMethod.GET, 'settlements/:id']);
  });
});
