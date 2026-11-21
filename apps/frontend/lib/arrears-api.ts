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

/** Task 5, proposed path. One line found later: a one-line batch through the same checks and approval. */
export function addArrearsSingleLine(tenant: string, token: string, input: ArrearsSingleLineInput) {
  return apiFetch<ArrearsBatchView>(tenant, '/arrears/lines', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}
