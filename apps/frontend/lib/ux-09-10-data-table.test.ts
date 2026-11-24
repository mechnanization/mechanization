import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CollectorCustodyPanel } from '@/components/admin/finance/collector-custody-panel';
import { AuditDaily } from '@/components/admin/audit-daily';
import type { CollectorCustodyView } from '@mechanization/shared-schemas';
import type { AuditDaySummary } from '@/lib/api-client';

/*
  UX-09 and UX-10 (cleanup sprint, decision U-2 of 2026-11-24): the collector
  custody panel, the inspector payouts page, the users section and the daily
  audit are drawn with `DataTable`, not the bare `ui/table`.

  The two that can be rendered here (their read is a query, which a seeded cache
  answers on the server) are checked on what a reader needs from the first
  paint; the other two are read as source, like the rest of this suite. This file
  has no DOM (only the citizen form and the building editor are mounted in jsdom so far), so what it cannot
  see is a click: opening a day,
  receiving a handover, suspending an account.
*/
vi.mock('next/navigation', () => ({
  useParams: () => ({ tenant: 't', locale: 'ar', adminPath: 'a' }),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/t/ar/a/finance/collectors',
  useSearchParams: () => new URLSearchParams(),
}));

const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const messages = JSON.parse(read('messages/ar.json'));
const custodyMessages = messages.finance.custody as Record<string, string | Record<string, string>>;
const auditMessages = messages.audit.daily as Record<string, string>;

function render(client: QueryClient, element: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'ar',
      messages,
      children: createElement(QueryClientProvider, { client, children: element }),
    }),
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const CUSTODY: CollectorCustodyView[] = [
  { accountId: 'a1', collectorId: 'c1', collectorName: 'Ali Haddad', currency: 'LBP', held: 5_000_000, movements: 3, lastCollectedAt: '2026-11-24T08:30:00Z', receiptsToday: 2, collectedToday: 3_000_000, status: 'COLLECTING_TODAY' },
  { accountId: 'a2', collectorId: 'c1', collectorName: 'Ali Haddad', currency: 'USD', held: 0, movements: 0, lastCollectedAt: null, receiptsToday: 0, collectedToday: 0, status: 'SETTLED' },
  { accountId: 'a3', collectorId: 'me', collectorName: 'Mona Khoury', currency: 'LBP', held: 1_000_000, movements: 1, lastCollectedAt: '2026-11-23T10:00:00Z', receiptsToday: 0, collectedToday: 0, status: 'NOT_OUT_TODAY' },
];

function renderCustody(role: string, rows = CUSTODY): string {
  const client = newClient();
  client.setQueryData(['treasury', 't', 'custody'], rows);
  return render(
    client,
    createElement(CollectorCustodyPanel, { tenant: 't', base: '/t/ar/a', token: 'tok', locale: 'ar', role, actorId: 'me' }),
  );
}

describe('the collector custody panel is a DataTable (UX-09)', () => {
  const html = renderCustody('SUPER_ADMIN');
  const columns = custodyMessages.columns as Record<string, string>;

  it('shows each column heading, and each wallet once as a table row and once as a phone card', () => {
    for (const heading of ['collector', 'status', 'today', 'held', 'lastActivity', 'actions']) {
      expect(html, heading).toContain(columns[heading]);
    }
    // three wallets, two collectors: Ali's two wallets are two rows, in the table and in the cards
    expect(html.match(/Ali Haddad/g)?.length).toBe(4);
    expect(html.match(/Mona Khoury/g)?.length).toBe(2);
    expect(html).toContain('<table');
    expect(html).toContain('sm:hidden');
  });

  it('offers «استلام» only where there is cash held and the row is not the signed-in person’s own', () => {
    const receive = custodyMessages.receive as string;
    // Ali's LBP wallet holds cash and is not the actor's: one button in the table, one in the card
    expect(html.match(new RegExp(`>${receive}<`, 'g'))?.length).toBe(2);
    // a role that cannot work the treasury sees none
    expect(renderCustody('VIEWER')).not.toContain(`>${receive}<`);
  });

  it('links each collector to what they collected, and a wallet with no collector to nothing', () => {
    expect(html).toContain('href="/t/ar/a/finance/collectors/c1"');
    const orphan = renderCustody('SUPER_ADMIN', [{ ...CUSTODY[0], accountId: 'a9', collectorId: null, collectorName: null }]);
    expect(orphan).not.toContain('/finance/collectors/');
    expect(orphan).toContain(custodyMessages.unknownCollector as string);
  });

  it('shows the stat strip’s totals above the table, one per currency', () => {
    expect(html).toContain((custodyMessages.stats as Record<string, string>).collectorsHolding);
  });

  it('draws the empty state, not a table, when there is no wallet', () => {
    const empty = renderCustody('SUPER_ADMIN', []);
    expect(empty).not.toContain('<table');
    expect(empty).toContain(custodyMessages.empty as string);
  });
});

describe('the daily audit is a DataTable whose rows open into their day (UX-10)', () => {
  const DAYS: AuditDaySummary[] = [
    { day: '2026-11-23', actor: { id: 'u1', kind: 'STAFF', name: 'Jawad Salem', role: 'INSPECTOR', email: null }, actions: [{ action: 'CREATE_BUILDING', count: 1 }, { action: 'ADD_UNIT', count: 6 }], total: 7, lastAt: '2026-11-23T14:05:00Z' },
    { day: '2026-11-22', actor: { id: null, kind: 'SYSTEM', name: null, role: null, email: null }, actions: [{ action: 'LOGIN', count: 2 }], total: 2, lastAt: '2026-11-22T06:00:00Z' },
  ];
  const client = newClient();
  client.setQueryData(['audit-daily', 't', '', '', '', '', '', 0], { items: DAYS, total: 2 });
  const html = render(client, createElement(AuditDaily, { tenant: 't', base: '/t/ar/a', locale: 'ar', token: 'tok', filter: {} }));

  it('lists each day with its person, and the system row by name', () => {
    expect(html).toContain('Jawad Salem');
    expect(html).toContain(auditMessages.system);
    expect(html).toContain('2026-11-23');
    expect(html).toContain('2026-11-22');
    expect(html).toContain('<table');
  });

  it('has a closed «عرض التفاصيل» for each day, in the table and in its phone card', () => {
    expect(html.match(new RegExp(`${auditMessages.viewDetails}`, 'g'))?.length).toBe(4);
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(4);
    expect(html).not.toContain('aria-expanded="true"');
  });

  it('opens nothing and reads no day’s trail until one is asked for', () => {
    expect(html).not.toContain(auditMessages.colChanges);
  });
});

describe('the payouts page and the users section are DataTables (UX-09, UX-10)', () => {
  const payouts = read('app/[tenant]/[locale]/[adminPath]/(protected)/inspector/profile/[staffId]/payouts/page.tsx');
  const users = read('components/admin/settings/users-section.tsx');

  it('neither draws the bare Table, and each reads its rows through DataTable', () => {
    for (const source of [payouts, users]) {
      expect(source).not.toMatch(/components\/ui\/table'/);
      expect(source).toMatch(/<DataTable\b/);
      expect(source).toMatch(/getRowId=/);
    }
  });

  it('the payouts page keeps its seven columns, its voucher print link and its failed-read behaviour', () => {
    for (const id of ['paidOn', 'amount', 'order', 'receipt', 'recordedBy', 'owedAfter', 'notes']) {
      expect(payouts, id).toContain(`id: '${id}'`);
    }
    expect(payouts).toMatch(/finance\/expenses\/\$\{voucher\.id\}\/print\?print=1/);
    expect(payouts).toMatch(/readView\(read, error\)/);
    expect(payouts).toMatch(/<InspectorPayoutDialog/);
    // a cancelled payout is struck through and badged, and still listed
    expect(payouts).toMatch(/voided && 'text-muted-foreground line-through'/);
    expect(payouts).toMatch(/t\('cancelled'\)/);
  });

  it('the users section keeps its search, its offline-aware error and its in-flight guard', () => {
    expect(users).toMatch(/<ErrorState compact description=\{error\} offline=\{offline\}/);
    expect(users).toMatch(/creatingRef/);
    expect(users).toMatch(/disabled=\{pendingId === row\.original\.id\}/);
  });
});

describe('DataTable draws an expanded row under its phone card too (U-2)', () => {
  const source = read('components/ui/data-table.tsx');

  it('MobileCards takes renderSubRow, gets it from the table, and draws it for an expanded row', () => {
    expect(source).toMatch(/function MobileCards<TData>\(\{[^}]*renderSubRow,/s);
    expect(source).toMatch(/<MobileCards[^>]*renderSubRow=\{renderSubRow\}/s);
    expect(source).toMatch(/renderSubRow && row\.getIsExpanded\(\) \? <div className="mt-3 border-t pt-3">/);
  });

  it('the daily audit passes it, so «عرض التفاصيل» does something on a phone', () => {
    expect(read('components/admin/audit-daily.tsx')).toMatch(/renderSubRow=\{\(row\) =>/);
  });

  it('the screens of UX-09 and UX-10 keep their held keys and guards where they were', () => {
    expect(read('components/admin/finance/collector-custody-panel.tsx')).toMatch(/heldKey\(tenant, `custody:\$\{receiving\.accountId\}`\)/);
  });
});
