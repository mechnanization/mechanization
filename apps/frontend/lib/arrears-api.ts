import type {
  ArrearsBatchView,
  ArrearsExportResult,
  ArrearsImportResult,
  ArrearsSingleLineInput,
  ExportArrearsTemplateInput,
  ImportArrearsInput,
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

/** One line found later: a one-line batch through the same checks and approval. */
export function addArrearsSingleLine(tenant: string, token: string, input: ArrearsSingleLineInput) {
  return apiFetch<ArrearsBatchView>(tenant, '/arrears/lines', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}
