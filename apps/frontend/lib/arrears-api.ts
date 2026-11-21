import type {
  ArrearsBatchView,
  ArrearsComponent,
  ArrearsControlTotalInput,
  ArrearsCutoffInput,
  ArrearsExportResult,
  ArrearsFeeType,
  ArrearsImportResult,
  ArrearsImportTotals,
  ArrearsLineVerdict,
  ArrearsSingleLineInput,
  DiscardArrearsBatchInput,
  ExportArrearsTemplateInput,
  ImportArrearsInput,
  LinkArrearsLineInput,
  ReturnArrearsBatchInput,
  SubmitArrearsBatchInput,
} from '@mechanization/shared-schemas';
import { apiFetch } from './api-client';

/**
 * Old debts, «متأخرات سنوات سابقة» (docs/old-debts-plan.md): the staff calls,
 * `ARREARS_PREPARE_ROLES`. Its own module, as `requests-api.ts` is, rather than
 * more of `api-client.ts`.
 *
 * **Built on the server (task 4):** `exportArrearsTemplate` and `importArrears`.
 *
 * **Not built yet (task 5):** listing batches, submitting one and entering a
 * single line. The contract (`arrears.schema.ts`) fixes their bodies and
 * `ArrearsBatchView`, not their paths: the paths below follow task 4's
 * (`batches/…`) and are this screen's proposal, kept here and nowhere else, so
 * task 5 either serves them or changes them in this one file. Until it lands
 * they answer 404 and the screen says it could not load or save.
 */

const batch = (id: string) => `/arrears/batches/${encodeURIComponent(id)}`;

/** «تصدير قالب»: a DRAFT batch for the next N citizens of a zone or a building, and the template's rows. */
export function exportArrearsTemplate(tenant: string, token: string, input: ExportArrearsTemplateInput) {
  return apiFetch<ArrearsExportResult>(tenant, '/arrears/batches/export', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** The filled template: checked (`dryRun`), or written into the DRAFT batch, refused whole while a row is refused. */
export function importArrears(tenant: string, token: string, batchId: string, input: ImportArrearsInput) {
  return apiFetch<ArrearsImportResult>(tenant, `${batch(batchId)}/import`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Task 5, proposed path. The batches, newest first. */
export function listArrearsBatches(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ items: ArrearsBatchView[] }>(tenant, '/arrears/batches', { token, signal });
}

/** Task 5, proposed path. «إرسال للاعتماد»: the draft, with the hand-added total of the pages copied. */
export function submitArrearsBatch(tenant: string, token: string, batchId: string, input: SubmitArrearsBatchInput) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/submit`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ───────────────────  approval, «للمطابقة», settings (task 8)  ───────────────────
//
// Every route below is task 5's (or, for the settings, no task's yet) and not
// built, and so are the two views the contract does not hold: a batch as the
// manager reviews it, and a line waiting for a file. Both shapes are this
// screen's proposal, built from the contract's own pieces; task 5 serves them or
// changes them here.

/** One year × fee type × component of a batch, summed: what the manager approves. */
export interface ArrearsBatchTotalRow {
  year: number;
  feeType: ArrearsFeeType;
  component: ArrearsComponent;
  count: number;
  amount: number;
}

/** Proposed for task 5: a submitted batch as the manager reviews it. */
export interface ArrearsBatchReview {
  batch: ArrearsBatchView;
  totals: ArrearsImportTotals;
  byYearAndFee: ArrearsBatchTotalRow[];
  /** The lines the preparer kept or dropped by hand: war damage, an archived file, «للمطابقة». */
  flagged: ArrearsLineVerdict[];
  /** What approval raises: one bill per kept line with a citizen. */
  bills: { count: number; amount: number; citizens: number };
}

/** Proposed for task 5: a «للمطابقة» line of an approved batch, waiting for a file. */
export interface ArrearsUnmatchedLine {
  id: string;
  batchId: string;
  sourceName: string;
  propertyNumber: string;
  unitCode: string | null;
  year: number;
  feeType: ArrearsFeeType;
  component: ArrearsComponent;
  amount: number;
}

/** Proposed: the cutoff and the old books' totals per year (open-decisions §23.4). */
export interface ArrearsSettingsView {
  arrearsCutoffYear: number | null;
  controlTotals: ArrearsControlTotalInput[];
}

/** Task 5, proposed path. */
export function getArrearsBatchReview(tenant: string, token: string, batchId: string, signal?: AbortSignal) {
  return apiFetch<ArrearsBatchReview>(tenant, `${batch(batchId)}/review`, { token, signal });
}

/** Task 5, proposed path. Approval raises the bills, in one transaction, and locks the batch. */
export function approveArrearsBatch(tenant: string, token: string, batchId: string) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/approve`, { token, method: 'POST', body: '{}' });
}

/** Task 5, proposed path. Back to the preparer as a DRAFT, with what to fix. */
export function returnArrearsBatch(tenant: string, token: string, batchId: string, input: ReturnArrearsBatchInput) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/return`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Task 5, proposed path. */
export function discardArrearsBatch(tenant: string, token: string, batchId: string, input: DiscardArrearsBatchInput) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/discard`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Task 5, proposed path. */
export function getUnmatchedArrearsLines(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ items: ArrearsUnmatchedLine[] }>(tenant, '/arrears/lines/unmatched', { token, signal });
}

/** Task 5, proposed path. Links a «للمطابقة» line to a file; its bill is raised then. */
export function linkArrearsLine(tenant: string, token: string, lineId: string, input: LinkArrearsLineInput) {
  return apiFetch<ArrearsUnmatchedLine>(tenant, `/arrears/lines/${encodeURIComponent(lineId)}/link`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Proposed path, no task yet. */
export function getArrearsSettings(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<ArrearsSettingsView>(tenant, '/arrears/settings', { token, signal });
}

/** Proposed path, no task yet. */
export function saveArrearsCutoff(tenant: string, token: string, input: ArrearsCutoffInput) {
  return apiFetch<ArrearsSettingsView>(tenant, '/arrears/settings/cutoff', {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** Proposed path, no task yet. One year's total; the table is undecided (open-decisions §23.4). */
export function saveArrearsControlTotal(tenant: string, token: string, input: ArrearsControlTotalInput) {
  return apiFetch<ArrearsSettingsView>(tenant, '/arrears/settings/control-totals', {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** Task 5, proposed path. One line found later: a one-line batch through the same checks and approval. */
export function addArrearsSingleLine(tenant: string, token: string, input: ArrearsSingleLineInput) {
  return apiFetch<ArrearsBatchView>(tenant, '/arrears/lines', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}
