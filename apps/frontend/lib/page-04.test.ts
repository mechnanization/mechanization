// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import {
  ARREARS_PREPARE_ROLES,
  ARREARS_REPORT_ROLES,
  FEE_EXEMPTION_READ_ROLES,
  FEE_ISSUE_ROLES,
  PAYMENT_REVIEW_READ_ROLES,
  STAFF_ROLE,
} from '@mechanization/shared-schemas';
import { FeesHeaderActions } from '@/components/admin/fees/fees-header-actions';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  PAGE-04 (cleanup sprint, 2026-11-25): the fees page's header offers one primary action, one secondary, and
  the pages around the ledger in one «المزيد» menu, each behind the role check it had. It was eight controls
  in a row, and the page's job, «إصدار رسم جديد», was off-screen at 360px.

  The real component is rendered for every role, with what the page passes it taken from the same role sets
  the page reads, so the expectation cannot drift from the gate.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const has = (roles: readonly string[], role: string) => roles.includes(role);

let container: HTMLDivElement;
let root: Root;

async function render(role: string, locale: 'ar' | 'en', onDirectCharge = vi.fn()): Promise<void> {
  const messages = locale === 'en' ? en : ar;
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: messages as never,
        children: createElement(FeesHeaderActions, {
          base: '/t/ar/a',
          locale,
          canIssue: has(FEE_ISSUE_ROLES, role),
          onDirectCharge,
          canReadCorrections: has(PAYMENT_REVIEW_READ_ROLES, role),
          canReadExemptions: has(FEE_EXEMPTION_READ_ROLES, role),
          canPrepareArrears: has(ARREARS_PREPARE_ROLES, role),
          canReadArrearsReport: has(ARREARS_REPORT_ROLES, role),
        }),
      }),
    );
  });
}

/** What is drawn in the header, in reading order: links and buttons by their text. */
const controls = () =>
  [...container.querySelectorAll('a, button')].map((node) => node.textContent?.trim() ?? '');

/** Radix opens a menu on Enter from its trigger; the items are drawn in a portal. */
async function openMenu(): Promise<string[]> {
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  if (!trigger) throw new Error('no menu trigger');
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  return [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent?.trim() ?? '');
}
const hrefs = () => [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.getAttribute('href'));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('the header’s order: the primary action first, then the secondary, then the menu', () => {
  it.each(['ar', 'en'] as const)('for a role that issues fees, in %s', async (locale) => {
    const issuer = STAFF_ROLE.find((role) => has(FEE_ISSUE_ROLES, role))!;
    await render(issuer, locale);
    const messages = (locale === 'en' ? en : ar).fees.header;
    expect(controls()).toEqual([messages.issue, messages.directCharge, messages.more]);
    // «إصدار رسم جديد» is the one link-shaped primary; «تكليف مباشر» a button.
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/t/ar/a/fees/new');
  });

  it('presses «تكليف مباشر» through to the page', async () => {
    const issuer = STAFF_ROLE.find((role) => has(FEE_ISSUE_ROLES, role))!;
    const onDirectCharge = vi.fn();
    await render(issuer, 'en', onDirectCharge);
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(en.fees.header.directCharge));
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onDirectCharge).toHaveBeenCalledTimes(1);
  });

  it.each(STAFF_ROLE)('offers %s no «تحديث» or "Refresh"', async (role) => {
    await render(role, 'ar');
    const menu = await openMenu();
    expect([...controls(), ...menu].join('|')).not.toMatch(/تحديث|Refresh/);
  });
});

describe('each link in the menu keeps its own role check', () => {
  const EXPECTED = (role: string): string[] => [
    ...(has(PAYMENT_REVIEW_READ_ROLES, role) ? ['/t/ar/a/fees/corrections'] : []),
    '/t/ar/a/fees/notices',
    ...(has(FEE_EXEMPTION_READ_ROLES, role) ? ['/t/ar/a/fees/exemptions'] : []),
    ...(has(ARREARS_PREPARE_ROLES, role) ? ['/t/ar/a/fees/arrears'] : []),
    ...(has(ARREARS_REPORT_ROLES, role) ? ['/t/ar/a/fees/arrears/report'] : []),
  ];

  it.each(STAFF_ROLE)('%s sees exactly the pages its roles open, «إشعارات الرسوم» always', async (role) => {
    await render(role, 'ar');
    const labels = await openMenu();
    expect(hrefs()).toEqual(EXPECTED(role));
    expect(labels).toHaveLength(EXPECTED(role).length);
    expect(hrefs()).toContain('/t/ar/a/fees/notices');
    // The primary and secondary actions are the issuers' alone.
    expect(controls().includes(ar.fees.header.issue)).toBe(has(FEE_ISSUE_ROLES, role));
  });

  it('a role that issues nothing is left with the menu alone', async () => {
    const reader = STAFF_ROLE.find((role) => !has(FEE_ISSUE_ROLES, role));
    expect(reader).toBeDefined();
    await render(reader!, 'en');
    expect(controls()).toEqual([en.fees.header.more]);
  });

  it('names «فواتير تأثّرت بتصحيحات» as its row does, from the shared key', async () => {
    const reviewer = STAFF_ROLE.find((role) => has(PAYMENT_REVIEW_READ_ROLES, role))!;
    await render(reviewer, 'en');
    expect(await openMenu()).toContain(en.nav.items.feeCorrections);
  });
});

describe('the page draws it, and no longer draws its own', () => {
  const page = read('app/[tenant]/[locale]/[adminPath]/(protected)/fees/page.tsx');

  it('hands the header to FeesHeaderActions, with the role checks it already computed', () => {
    expect(page).toMatch(/<FeesHeaderActions[\s\S]*?canIssue=\{canIssue\}[\s\S]*?canReadCorrections=\{canReadCorrections\}[\s\S]*?canReadExemptions=\{canReadExemptions\}[\s\S]*?canPrepareArrears=\{canPrepareArrears\}[\s\S]*?canReadArrearsReport=\{canReadArrearsReport\}/);
    expect(page).toMatch(/onDirectCharge=\{\(\) => setChargeOpen\(true\)\}/);
  });

  it('has no refresh button, no RefreshCw and no `refreshing` flag left', () => {
    expect(page).not.toMatch(/RefreshCw|refreshing|'تحديث'/);
  });

  it('says its two actions in messages, in both languages', () => {
    for (const messages of [en, ar]) {
      for (const key of ['issue', 'directCharge', 'more'] as const) expect(messages.fees.header[key]).toBeTruthy();
    }
    const source = read('components/admin/fees/fees-header-actions.tsx');
    expect(source).not.toMatch(/locale === 'en' \?/);
  });
});
