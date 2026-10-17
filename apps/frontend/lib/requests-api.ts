import type {
  ApproveRequestInput,
  CitizenRequestListResult,
  CitizenRequestView,
  MyCitizenRequestView,
  RaiseRequestBillResult,
  RejectRequestInput,
  RequestAttachmentType,
  RequestAttachmentUrl,
  RequestAttachmentView,
  RequestChannel,
  RequestStatus,
  RequestType,
  RequestTypeSettingView,
  SubmitCounterRequestInput,
  SubmitOnlineRequestInput,
  SubmitRequestResult,
  UpdateRequestTypeSettingInput,
} from '@mechanization/shared-schemas';
import { apiFetch } from './api-client';

/**
 * المعاملات والإفادات — municipal requests (docs/municipal-requests-plan.md).
 *
 * Its own module rather than more of `api-client.ts` (6,700 lines): the screens
 * that use it are new, and nothing else needs these shapes. `requests/mine/…`
 * is the citizen's portal (a citizen token; the server refuses staff); the rest
 * is staff, each route with its role set (`REQUEST_*_ROLES`).
 */

export type {
  CitizenRequestListItem,
  CitizenRequestListResult,
  CitizenRequestView,
  MyCitizenRequestView,
  RaiseRequestBillResult,
  RequestAttachmentUrl,
  RequestAttachmentView,
  RequestBillView,
  RequestClearanceSnapshot,
  RequestPropertyView,
  RequestTypeSettingView,
  SubmitRequestResult,
} from '@mechanization/shared-schemas';

const path = (id: string) => `/requests/${encodeURIComponent(id)}`;

// ─────────────────────────────  Staff  ─────────────────────────────

/** The queue — `REQUEST_READ_ROLES`, `GET /requests`. Pages count from 1. */
export function getRequestQueue(
  tenant: string,
  token: string,
  args: {
    status?: RequestStatus;
    channel?: RequestChannel;
    type?: RequestType;
    search?: string;
    page?: number;
    pageSize?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.status) query.set('status', args.status);
  if (args.channel) query.set('channel', args.channel);
  if (args.type) query.set('type', args.type);
  if (args.search) query.set('search', args.search);
  if (args.page) query.set('page', String(args.page));
  if (args.pageSize) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<CitizenRequestListResult>(tenant, `/requests${suffix}`, { token, signal });
}

/** One request, as staff read it — `REQUEST_READ_ROLES`, `GET /requests/:id`. */
export function getRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<CitizenRequestView>(tenant, path(args.id), { token, signal });
}

/** Every type, offered or not, with its fee — `REQUEST_READ_ROLES`, `GET /requests/types`. */
export function getRequestTypes(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<RequestTypeSettingView[]>(tenant, '/requests/types', { token, signal });
}

/** Switch a type on or off and set its fee — the manager, `PUT /requests/types/:type`. */
export function updateRequestType(
  tenant: string,
  token: string,
  args: { type: RequestType } & UpdateRequestTypeSettingInput,
  signal?: AbortSignal,
) {
  const { type, ...body } = args;
  return apiFetch<RequestTypeSettingView[]>(tenant, `/requests/types/${encodeURIComponent(type)}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/** A request filed at the counter — `REQUEST_HANDLE_ROLES`, `POST /requests`. */
export function submitCounterRequest(tenant: string, token: string, args: SubmitCounterRequestInput, signal?: AbortSignal) {
  return apiFetch<SubmitRequestResult>(tenant, '/requests', { method: 'POST', token, body: JSON.stringify(args), signal });
}

/** «تحصيل الرسم»: the fee's bill, raised or answered — `REQUEST_BILL_ROLES`, `POST /requests/:id/bill`. */
export function raiseRequestBill(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<RaiseRequestBillResult>(tenant, `${path(args.id)}/bill`, { method: 'POST', token, signal });
}

/** «جاهزة للاستلام» — `REQUEST_HANDLE_ROLES`, `POST /requests/:id/approve`. */
export function approveRequest(tenant: string, token: string, args: { id: string } & ApproveRequestInput, signal?: AbortSignal) {
  const { id, ...body } = args;
  return apiFetch<CitizenRequestView>(tenant, `${path(id)}/approve`, { method: 'POST', token, body: JSON.stringify(body), signal });
}

/** «رفض الطلب» — `REQUEST_HANDLE_ROLES`, `POST /requests/:id/reject`. */
export function rejectRequest(tenant: string, token: string, args: { id: string } & RejectRequestInput, signal?: AbortSignal) {
  const { id, ...body } = args;
  return apiFetch<CitizenRequestView>(tenant, `${path(id)}/reject`, { method: 'POST', token, body: JSON.stringify(body), signal });
}

/** «تسليم المعاملة» — `REQUEST_HANDLE_ROLES`, `POST /requests/:id/complete`. */
export function completeRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<CitizenRequestView>(tenant, `${path(args.id)}/complete`, { method: 'POST', token, signal });
}

/** «إلغاء الطلب», while no bill is raised — `REQUEST_HANDLE_ROLES`, `POST /requests/:id/cancel`. */
export function cancelRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<CitizenRequestView>(tenant, `${path(args.id)}/cancel`, { method: 'POST', token, signal });
}

/** A paper added by staff — `REQUEST_HANDLE_ROLES`, `POST /requests/:id/attachments` (multipart). */
export function uploadRequestAttachment(
  tenant: string,
  token: string,
  args: { id: string; type: RequestAttachmentType; file: Blob; fileName?: string },
  signal?: AbortSignal,
) {
  return apiFetch<RequestAttachmentView>(tenant, `${path(args.id)}/attachments`, {
    method: 'POST',
    token,
    body: attachmentForm(args),
    signal,
  });
}

/** A five-minute link to one paper — `REQUEST_READ_ROLES`, audited on the server. */
export function getRequestAttachmentUrl(
  tenant: string,
  token: string,
  args: { id: string; attachmentId: string },
  signal?: AbortSignal,
) {
  return apiFetch<RequestAttachmentUrl>(
    tenant,
    `${path(args.id)}/attachments/${encodeURIComponent(args.attachmentId)}/url`,
    { token, signal },
  );
}

// ─────────────────────────────  The citizen's own  ─────────────────────────────

/** «طلباتي» — a citizen token, `GET /requests/mine`. */
export function getMyRequests(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<MyCitizenRequestView[]>(tenant, '/requests/mine', { token, signal });
}

/** One of the citizen's requests — `GET /requests/mine/:id`. */
export function getMyRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<MyCitizenRequestView>(tenant, `/requests/mine/${encodeURIComponent(args.id)}`, { token, signal });
}

/** The types a citizen may file now, with their fees — `GET /requests/mine/types`. */
export function getOfferedRequestTypes(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<RequestTypeSettingView[]>(tenant, '/requests/mine/types', { token, signal });
}

/** «إرسال الطلب» — `POST /requests/mine`. */
export function submitMyRequest(tenant: string, token: string, args: SubmitOnlineRequestInput, signal?: AbortSignal) {
  return apiFetch<SubmitRequestResult>(tenant, '/requests/mine', { method: 'POST', token, body: JSON.stringify(args), signal });
}

/** A paper on the citizen's own request — `POST /requests/mine/:id/attachments` (multipart). */
export function uploadMyRequestAttachment(
  tenant: string,
  token: string,
  args: { id: string; type: RequestAttachmentType; file: Blob; fileName?: string },
  signal?: AbortSignal,
) {
  return apiFetch<RequestAttachmentView>(tenant, `/requests/mine/${encodeURIComponent(args.id)}/attachments`, {
    method: 'POST',
    token,
    body: attachmentForm(args),
    signal,
  });
}

/** «ادفع الآن»: the fee's bill, raised or answered — `POST /requests/mine/:id/bill`. */
export function raiseMyRequestBill(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<RaiseRequestBillResult>(tenant, `/requests/mine/${encodeURIComponent(args.id)}/bill`, {
    method: 'POST',
    token,
    signal,
  });
}

/** «إلغاء الطلب», while no bill is raised — `POST /requests/mine/:id/cancel`. */
export function cancelMyRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<MyCitizenRequestView>(tenant, `/requests/mine/${encodeURIComponent(args.id)}/cancel`, {
    method: 'POST',
    token,
    signal,
  });
}

/** The text field first, then the file: the server reads the type before the bytes. */
function attachmentForm(args: { type: RequestAttachmentType; file: Blob; fileName?: string }): FormData {
  const form = new FormData();
  form.append('type', args.type);
  form.append('file', args.file, args.fileName ?? 'paper');
  return form;
}
