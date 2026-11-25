/*
  What the nets under «ملاحظات الجودة» share (PAGE-13): findings of every shape the list draws. The screen, the
  address and the waiting are the review queue's (`quality-review-harness.ts`); each net mounts the list itself,
  since no module of `lib` imports a component (ARCH-20). Not a test file, and no application code imports it.
*/
import type { QualityFinding } from '@/lib/quality-api';

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const D = 'd0000000-0000-4000-8000-00000000000d';

const finding = (over: Partial<QualityFinding> & Pick<QualityFinding, 'kind' | 'subjectKey'>): QualityFinding => ({
  severity: 'MEDIUM',
  detail: 'A sentence',
  subjects: [],
  officers: [],
  at: '2026-11-20T08:30:00Z',
  dismissable: true,
  dismissal: null,
  ...over,
});

/** Two files for one person: set side by side, and closable by hand. */
export const TWICE = finding({
  kind: 'DUPLICATE_CITIZEN',
  subjectKey: `${A},${B}`,
  severity: 'HIGH',
  detail: 'Two files carry «OWNER» and «VACANT» — compare them',
  subjects: [
    { kind: 'citizen', id: A, label: 'Ali Hassan', secondary: 'C-1' },
    { kind: 'citizen', id: B, label: 'Ali Hasan', secondary: null },
  ],
  officers: [
    { id: 'o1', name: 'Rima Haddad' },
    { id: 'o2', name: 'Karim Saleh' },
  ],
});
/** A building with flats unmeasured: put right in its matrix, and not closable by hand. */
export const NO_AREA = finding({
  kind: 'UNITS_WITHOUT_AREA',
  subjectKey: C,
  severity: 'LOW',
  detail: 'Four flats have no area — no reason was given',
  subjects: [{ kind: 'building', id: C, label: 'X-498-A', secondary: '498' }],
  dismissable: false,
  at: null,
});
/** The same building, with no entrance pin: shares a record with the one above. */
export const NO_PIN = finding({
  kind: 'BUILDING_WITHOUT_PIN',
  subjectKey: C,
  detail: 'No entrance pin',
  subjects: [{ kind: 'building', id: C, label: 'X-498-A', secondary: null }],
});
/** Already closed by a reviewer. */
export const SETTLED = finding({
  kind: 'OCCUPANT_HAS_LANDLORD_PHONE',
  subjectKey: D,
  detail: 'The occupant’s number is the landlord’s',
  subjects: [{ kind: 'citizen', id: D, label: 'Salma Noun', secondary: 'C-4' }],
  dismissal: { reason: 'Mother and son', by: 'Reviewer One', at: '2026-11-22T09:00:00Z' },
});
/** About no record at all: the owner-link queue. */
export const UNLINKED = finding({
  kind: 'UNLINKED_LANDLORDS',
  subjectKey: 'queue',
  detail: 'Twelve owners are named and not linked',
});

export const ALL = [TWICE, NO_AREA, NO_PIN, UNLINKED];

export const findings = (items: QualityFinding[] = ALL) => ({
  items,
  counts: {
    DUPLICATE_CITIZEN: { open: 1, dismissed: 0 },
    UNITS_WITHOUT_AREA: { open: 1, dismissed: 0 },
    BUILDING_WITHOUT_PIN: { open: 1, dismissed: 0 },
    UNLINKED_LANDLORDS: { open: 1, dismissed: 0 },
    OCCUPANT_HAS_LANDLORD_PHONE: { open: 0, dismissed: 1 },
  },
});

export const SETTLE_RESULT = {
  unitsChecked: 40,
  statusesChanged: 3,
  casesOpened: 2,
  casesResolved: 1,
  stillUnderReview: 5,
};
