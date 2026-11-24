import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { CitizenForm } from '@/components/admin/citizen-form';
import { emptyCitizen, type CitizenFormValues, type PropertyDraft } from '@/lib/citizen-form-values';

/*
  The citizen form, rendered on the server, for each kind of file (GOD-22, phase 2).

  There is no jsdom and no Testing Library here, and no browser to open the form
  in. What a server render does give is the HTML of the first paint, and the form
  keeps every step's page in it (the ones not shown are `hidden`), together with
  the step bar and both action bars. So a refactor that only moves markup into
  other files can be checked byte for byte: render before, render after, compare.

  What this does NOT see: effects (they do not run on the server), anything that
  happens after a click, and the five dialogs, which are closed on first paint.
  Those are the parts a move can break without this test noticing; the pure
  helpers have their own tests (`citizen-form-logic.test.ts`) and the rest is read
  in review and tried on staging.

  The expected HTML is not committed — seven pages of it would be half a megabyte.
  What is committed is each page's length and SHA-256, in
  `lib/__fixtures__/citizen-form-render.json`. When one differs:

    CITIZEN_FORM_DUMP=<dir> pnpm --filter @mechanization/frontend test -- citizen-form-render

  writes every page as one tag per line, to diff against a dump from the commit
  before; and when the markup changed on purpose,

    UPDATE_CITIZEN_FORM_RENDER=1 pnpm --filter @mechanization/frontend test -- citizen-form-render

  rewrites the fixture. Rendered with the date fixed and `useId`'s numbers renamed
  by first appearance, so neither a clock nor where a component sits changes it.
*/

vi.mock('next/navigation', () => ({
  useParams: () => ({ tenant: 't', locale: 'ar', adminPath: 'a' }),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/t/ar/a/citizens/new',
  useSearchParams: () => new URLSearchParams(),
}));

const FIXTURE = join(__dirname, '__fixtures__', 'citizen-form-render.json');
const messages = {
  ar: JSON.parse(readFileSync(join(__dirname, '../messages/ar.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(__dirname, '../messages/en.json'), 'utf8')),
};

const card = (patch: Record<string, unknown>): PropertyDraft => patch as PropertyDraft;
const record = (patch: Partial<CitizenFormValues> = {}): CitizenFormValues => ({ ...emptyCitizen(), ...patch });

interface Scenario {
  locale: 'ar' | 'en';
  mode: 'create' | 'edit';
  values: CitizenFormValues;
  props?: Record<string, unknown>;
}

/** One page per kind of file, a record with every kind of card, and the form's other states. */
const SCENARIOS: Record<string, Scenario> = {
  'household-create-ar': { locale: 'ar', mode: 'create', values: record() },
  'household-create-en': { locale: 'en', mode: 'create', values: record() },
  'non-resident-owner-ar': { locale: 'ar', mode: 'create', values: record({ residence: 'NON_RESIDENT_OWNER' }) },
  'estate-ar': { locale: 'ar', mode: 'create', values: record({ residence: 'ESTATE' }) },
  'institution-ar': { locale: 'ar', mode: 'create', values: record({ residence: 'INSTITUTION' }) },
  'household-with-cards-edit-ar': {
    locale: 'ar',
    mode: 'edit',
    values: record({
      personal: { isLebanese: true, firstName: 'Amal', lastName: 'Haddad', gender: 'FEMALE' },
      contact: { phone: '71123456', whatsappSameAsPhone: true, hasNoPhone: false },
      properties: [
        card({ propertyType: 'HOUSE', occupancyType: 'OWNER', neighborhood: 'Old Town', propertyNumber: '12' }),
        card({
          propertyType: 'BUILDING',
          occupancyType: 'OWNER',
          neighborhood: 'Old Town',
          propertyNumber: '12',
          units: [{ unitType: 'APARTMENT' }, { unitType: 'SHOP' }],
        }),
        card({ propertyType: 'HOUSE', occupancyType: 'TENANT', neighborhood: 'New Town', landlordName: 'Z' }),
      ],
      flags: new Map([
        ['personal.motherName', 'not known'],
        ['properties.0.neighborhood', 'unsure'],
      ]),
    }),
    props: { citizenId: 'citizen-1', token: 'tok', canMerge: true, canOverrideDuplicates: true, canAnswerLandlord: true },
  },
  'household-offline-saving-ar': {
    locale: 'ar',
    mode: 'create',
    values: record(),
    props: { offline: true, submitting: true, error: 'تعذّر الحفظ' },
  },
};

/** `useId` numbers renamed by first appearance, so moving a component does not change the page. */
function normalise(html: string): string {
  const seen = new Map<string, string>();
  return html.replace(/:[Rr][0-9a-z]+:/g, (id) => {
    if (!seen.has(id)) seen.set(id, `:id${seen.size}:`);
    return seen.get(id)!;
  });
}

function render(scenario: Scenario): string {
  return normalise(
    renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        {
          locale: scenario.locale,
          messages: messages[scenario.locale],
          children: createElement(CitizenForm, {
            tenant: 't',
            config: {
              slug: 't',
              name: 't',
              nameAr: 't',
              enabledPropertyTypes: ['BUILDING', 'HOUSE', 'LAND', 'TENT'],
              requiredDocuments: [],
              branding: {},
            },
            mode: scenario.mode,
            initial: scenario.values,
            submitting: false,
            error: null,
            onSubmit() {},
            onCancel() {},
            locale: scenario.locale,
            canAnswerLandlord: false,
            ...scenario.props,
          }),
        },
      ),
    ),
  );
}

const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });

const observed: Record<string, { length: number; sha256: string }> = {};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
  if (process.env.UPDATE_CITIZEN_FORM_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});

describe('the citizen form’s first paint', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_CITIZEN_FORM_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(Object.keys(SCENARIOS))('%s is the page it was', (name) => {
    const html = render(SCENARIOS[name]);
    observed[name] = fingerprint(html);

    const dump = process.env.CITIZEN_FORM_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_CITIZEN_FORM_RENDER) return;
    expect(observed[name], `${name}: set CITIZEN_FORM_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('each page is rendered twice the same, so a difference is a change and not noise', () => {
    for (const name of Object.keys(SCENARIOS)) expect(render(SCENARIOS[name])).toBe(render(SCENARIOS[name]));
  });

  it('every kind of file has its own page, and each shows the three steps', () => {
    for (const name of ['household-create-ar', 'non-resident-owner-ar', 'estate-ar', 'institution-ar']) {
      const html = render(SCENARIOS[name]);
      for (const id of ['personal', 'contact', 'properties']) expect(html, `${name} ${id}`).toContain(`id="${id}"`);
    }
    const pages = new Set(['household-create-ar', 'non-resident-owner-ar', 'estate-ar', 'institution-ar'].map((n) => render(SCENARIOS[n])));
    expect(pages.size).toBe(4);
  });

  it('the page with cards shows each of its three', () => {
    const html = render(SCENARIOS['household-with-cards-edit-ar']);
    expect(html).toContain('value="Amal"');
    // each card's own fields, the building's two flats, and the tenant's landlord block
    for (const path of [
      'properties.0.propertyNumber',
      'properties.1.units.0.unitStatus',
      'properties.1.units.1.unitStatus',
      'properties.2.landlordName',
      'properties.2.landlordPhone',
    ]) {
      expect(html, path).toContain(`data-field-path="${path}"`);
    }
    // a flagged field shows the reason the officer gave
    expect(html).toContain('value="not known"');
  });
});
