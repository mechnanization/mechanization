import type {
  CreateRequestFormInput,
  OfferedRequestForm,
  RequestFormListItem,
  RequestFormPrefill,
  RequestFormView,
  SaveRequestFormDraftInput,
  UpdateRequestFormInput,
} from '@mechanization/shared-schemas';
import { apiFetch } from './api-client';

/**
 * «نماذج الإفادات» — the request forms the manager defines (docs/request-forms-plan.md §5).
 *
 * Staff read them on `REQUEST_READ_ROLES` and the manager alone writes (`REQUEST_SETTINGS_ROLES`); the forms a citizen or the
 * counter fills are `getMyOfferedForms` and `getCounterForms`. A module of its own, like `requests-api.ts`: the shapes are the
 * shared contract's, never copied here.
 */

export type {
  OfferedRequestField,
  OfferedRequestForm,
  RequestAnswerView,
  RequestFormFieldView,
  RequestFormListItem,
  RequestFormPrefill,
  RequestFormRef,
  RequestFormVersionView,
  RequestFormView,
  RequestMissingPaper,
} from '@mechanization/shared-schemas';

const path = (id: string) => `/request-forms/${encodeURIComponent(id)}`;

/** The manager's list — `GET /request-forms`. */
export function getRequestForms(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<RequestFormListItem[]>(tenant, '/request-forms', { token, signal });
}

/** One form with its current version and its draft — `GET /request-forms/:id`. */
export function getRequestForm(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<RequestFormView>(tenant, path(id), { token, signal });
}

/** «نموذج جديد»: the settings only; the questions are saved as a draft next. */
export function createRequestForm(tenant: string, token: string, body: CreateRequestFormInput) {
  return apiFetch<RequestFormView>(tenant, '/request-forms', { method: 'POST', token, body: JSON.stringify(body) });
}

export function updateRequestForm(tenant: string, token: string, id: string, body: UpdateRequestFormInput) {
  return apiFetch<RequestFormView>(tenant, path(id), { method: 'PUT', token, body: JSON.stringify(body) });
}

/** «تعديل النموذج»: the draft to edit — the one that exists, or a copy of the published questions. */
export function startRequestFormDraft(tenant: string, token: string, id: string) {
  return apiFetch<RequestFormView>(tenant, `${path(id)}/draft`, { method: 'POST', token });
}

/** The draft's questions, saved whole; a stale `expectedRevision` is `REQUEST_FORM_EDIT_CONFLICT`. */
export function saveRequestFormDraft(tenant: string, token: string, id: string, body: SaveRequestFormDraftInput) {
  return apiFetch<RequestFormView>(tenant, `${path(id)}/draft`, { method: 'PUT', token, body: JSON.stringify(body) });
}

export function publishRequestForm(tenant: string, token: string, id: string) {
  return apiFetch<RequestFormView>(tenant, `${path(id)}/publish`, { method: 'POST', token });
}

export function setRequestFormEnabled(tenant: string, token: string, id: string, enabled: boolean) {
  return apiFetch<RequestFormView>(tenant, `${path(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', token });
}

export function archiveRequestForm(tenant: string, token: string, id: string) {
  return apiFetch<RequestFormView>(tenant, `${path(id)}/archive`, { method: 'POST', token });
}

export function deleteRequestForm(tenant: string, token: string, id: string) {
  return apiFetch<{ id: string }>(tenant, path(id), { method: 'DELETE', token });
}

/** The forms the counter may file now — `REQUEST_HANDLE_ROLES`, `GET /requests/forms`. */
export function getCounterForms(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<OfferedRequestForm[]>(tenant, '/requests/forms', { token, signal });
}

/** What the chosen citizen's file holds for each linked question — `GET /requests/forms/:formId/prefill`. */
export function getRequestFormPrefill(tenant: string, token: string, args: { formId: string; citizenId: string }, signal?: AbortSignal) {
  const query = new URLSearchParams({ citizenId: args.citizenId });
  return apiFetch<RequestFormPrefill>(tenant, `/requests/forms/${encodeURIComponent(args.formId)}/prefill?${query}`, { token, signal });
}

/** The forms a citizen may file now, with the values of their own file — a citizen token, `GET /requests/mine/forms`. */
export function getMyOfferedForms(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<OfferedRequestForm[]>(tenant, '/requests/mine/forms', { token, signal });
}
