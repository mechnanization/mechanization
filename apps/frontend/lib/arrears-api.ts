import type {
  ArrearsBatchReview,
  ArrearsBatchView,
  ArrearsCutoffInput,
  ArrearsExportResult,
  ArrearsImportResult,
  ArrearsSettingsView,
  ArrearsSingleLineInput,
  ArrearsUnmatchedLine,
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
 * Every route here is served by `ArrearsController` (tasks 4 and 5), and every
 * body and answer is a type from the shared contract (`arrears.schema.ts`).
 * The old books' totals per year are read (`getArrearsSettings`) and never
 * written: whether the municipality enters them is open-decisions §23.4.
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

/** The batches, newest first. */
export function listArrearsBatches(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ items: ArrearsBatchView[] }>(tenant, '/arrears/batches', { token, signal });
}

/** «إرسال للاعتماد»: the draft, with the hand-added total of the pages copied. */
export function submitArrearsBatch(tenant: string, token: string, batchId: string, input: SubmitArrearsBatchInput) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/submit`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ───────────────────  approval, «للمطابقة», settings (task 8)  ───────────────────

export function getArrearsBatchReview(tenant: string, token: string, batchId: string, signal?: AbortSignal) {
  return apiFetch<ArrearsBatchReview>(tenant, `${batch(batchId)}/review`, { token, signal });
}

/** Approval raises the bills, in one transaction, and locks the batch. */
export function approveArrearsBatch(tenant: string, token: string, batchId: string) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/approve`, { token, method: 'POST', body: '{}' });
}

/** Back to the preparer as a DRAFT, with what to fix. */
export function returnArrearsBatch(tenant: string, token: string, batchId: string, input: ReturnArrearsBatchInput) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/return`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function discardArrearsBatch(tenant: string, token: string, batchId: string, input: DiscardArrearsBatchInput) {
  return apiFetch<ArrearsBatchView>(tenant, `${batch(batchId)}/discard`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getUnmatchedArrearsLines(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ items: ArrearsUnmatchedLine[] }>(tenant, '/arrears/lines/unmatched', { token, signal });
}

/** Links a «للمطابقة» line to a file; its bill is raised then. */
export function linkArrearsLine(tenant: string, token: string, lineId: string, input: LinkArrearsLineInput) {
  return apiFetch<ArrearsUnmatchedLine>(tenant, `/arrears/lines/${encodeURIComponent(lineId)}/link`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getArrearsSettings(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<ArrearsSettingsView>(tenant, '/arrears/settings', { token, signal });
}

export function saveArrearsCutoff(tenant: string, token: string, input: ArrearsCutoffInput) {
  return apiFetch<ArrearsSettingsView>(tenant, '/arrears/settings/cutoff', {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** One line found later: a one-line batch through the same checks and approval. */
export function addArrearsSingleLine(tenant: string, token: string, input: ArrearsSingleLineInput) {
  return apiFetch<ArrearsBatchView>(tenant, '/arrears/lines', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}
