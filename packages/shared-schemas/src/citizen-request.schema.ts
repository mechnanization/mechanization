import { z } from 'zod';
import { typeError } from './type-error';
import {
  requestAttachmentTypeSchema,
  requestChannelSchema,
  requestStatusSchema,
  type ApplicantCapacity,
  type PropertyType,
  type RequestAttachmentType,
  type RequestChannel,
  type RequestStatus,
  type RequestType,
} from './enums';
// Type-only: the form's views are named here, and `request-form.schema.ts` reads this file's values.
import type { RequestAnswerView, RequestFormRef, RequestMissingPaper } from './request-form.schema';

/**
 * المعاملات والإفادات — a citizen asks the municipality for a paper, pays its fee,
 * and collects the stamped paper at the counter. Design:
 * docs/municipal-requests-plan.md; the decisions: docs/open-decisions.md §20;
 * the tables: tenant migration 0092.
 */

// ─── rules both apps read ───

/** Open: not yet handed over, rejected or cancelled. One per citizen, type and card. */
export const OPEN_REQUEST_STATUSES = [
  'AWAITING_PAYMENT',
  'IN_REVIEW',
  'READY_FOR_PICKUP',
] as const satisfies readonly RequestStatus[];

export function isOpenRequestStatus(status: RequestStatus): boolean {
  return (OPEN_REQUEST_STATUSES as readonly RequestStatus[]).includes(status);
}

/** The largest paper a request takes, checked by the browser and by the server's interceptor. */
export const REQUEST_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** How many papers one request may carry. */
export const REQUEST_ATTACHMENTS_MAX = 10;

/**
 * The kinds of file a paper may be: as the server sniffs them from the bytes,
 * never as the browser declares them (docs/security.md, uploads).
 */
export const REQUEST_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type RequestAttachmentMimeType = (typeof REQUEST_ATTACHMENT_MIME_TYPES)[number];

/** Until when a citizen may add papers: while the request is still being prepared or read. */
export const REQUEST_STATUSES_TAKING_ATTACHMENTS = [
  'AWAITING_PAYMENT',
  'IN_REVIEW',
] as const satisfies readonly RequestStatus[];

// ─── inputs ───

const uuid = (message: string) => z.string(typeError({ required: message })).guid(message);

/** «جاهزة للاستلام»: what the paper certifies, in the clerk's words (open decisions §20 D3). */
export const approveRequestSchema = z.object({
  statement: z
    .string(typeError({ required: 'اكتب نصّ الإفادة' }))
    .trim()
    .min(5, 'اكتب نصّ الإفادة')
    .max(2000, 'النصّ طويل جداً'),
});
export type ApproveRequestInput = z.infer<typeof approveRequestSchema>;

/** «رفض الطلب», with the reason the citizen will read. */
export const rejectRequestSchema = z.object({
  reason: z
    .string(typeError({ required: 'اكتب سبب الرفض' }))
    .trim()
    .min(5, 'اكتب سبب الرفض (٥ أحرف على الأقل)')
    .max(500, 'السبب طويل جداً'),
});
export type RejectRequestInput = z.infer<typeof rejectRequestSchema>;

/** A request's fee in whole pounds (D1): the one rule for a request type's setting and for a request form's own fee. */
export const requestFeeAmountSchema = z.coerce
  .number(typeError({ invalid: 'الرسم يجب أن يكون رقماً' }))
  .int('الرسم بالليرة، رقماً صحيحاً')
  .min(0, 'الرسم لا يكون سالباً')
  .max(1_000_000_000, 'الرسم كبير جداً — يرجى المراجعة');

/** The text field sent beside the file (`multipart/form-data`). */
export const uploadRequestAttachmentSchema = z.object({ type: requestAttachmentTypeSchema });
export type UploadRequestAttachmentInput = z.infer<typeof uploadRequestAttachmentSchema>;

/** The staff queue (`GET requests`). */
export const listRequestsQuerySchema = z.object({
  status: requestStatusSchema.optional(),
  channel: requestChannelSchema.optional(),
  /** The form the request was filled on (0113). */
  formId: uuid('اختر النموذج').optional(),
  search: z.string().trim().max(120).optional().transform((value) => (value ? value : undefined)),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;

// ─── response shapes ───


/** The bill a request's fee was charged on. */
export interface RequestBillView {
  citizenPaymentId: string;
  invoiceNumber: string | null;
  amount: number;
  paidAmount: number;
  currency: string;
  /** OVERDUE is derived, as everywhere: UNPAID past its due date. */
  paymentStatus: 'UNPAID' | 'PENDING_REVIEW' | 'PAID' | 'OVERDUE';
  dueDate: string;
}

/** The card a request names, as staff and the citizen read it. */
export interface RequestPropertyView {
  propertyEntryId: string;
  propertyNumber: string | null;
  propertyType: PropertyType;
  neighborhood: string | null;
  buildingName: string | null;
  unit: { buildingUnitId: string; unitCode: string | null; floor: string | null } | null;
}

/** A paper on a request. Its key in the bucket never leaves the server. */
export interface RequestAttachmentView {
  id: string;
  type: RequestAttachmentType;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Who added it: the citizen online, or staff. */
  uploadedByKind: 'CITIZEN' | 'STAFF';
  /** The file question of its form this paper answers (0113), or null for a paper on no question. */
  fieldKey: string | null;
  /** That question's words, so a screen names the paper by what it was asked for. Null with `fieldKey`. */
  fieldLabelAr: string | null;
  fieldLabelEn: string | null;
}

/** For a براءة ذمة: what was owed on the property when it was approved. */
export interface RequestClearanceSnapshot {
  propertyNumber: string;
  /** Owed on the parcel by its bills' own lines; 0 when approved. */
  total: number;
  /** Open bills of the people on the parcel that name no unit — shown to the clerk, not blocking. */
  unlinkedTotal: number;
  checkedAt: string;
}

/** One line of the staff queue. */
export interface CitizenRequestListItem {
  id: string;
  requestNumber: string;
  status: RequestStatus;
  channel: RequestChannel;
  requestType: RequestType;
  /** The form the request was filled on (0113), or null for a request on no form; a form request's `requestType` is `OTHER` or its built-in type. */
  form: RequestFormRef | null;
  citizenId: string;
  citizenName: string;
  propertyNumber: string | null;
  /**
   * The fee: the bill's amount once raised; before, the type's current fee while
   * the request waits for it (AWAITING_PAYMENT). Null when no bill was raised and
   * none will be: a free, waived, cancelled or rejected request shows no fee.
   */
  fee: number | null;
  billStatus: RequestBillView['paymentStatus'] | null;
  attachmentCount: number;
  createdAt: string;
}

export interface CitizenRequestListResult {
  items: CitizenRequestListItem[];
  total: number;
}

/** A request as staff read it, in the panel and on the printed paper. */
export interface CitizenRequestView {
  id: string;
  requestNumber: string;
  status: RequestStatus;
  channel: RequestChannel;
  requestType: RequestType;
  /** Null when the request's form does not ask for it (0113); every request filed before forms has one. */
  applicantCapacity: ApplicantCapacity | null;
  citizen: {
    id: string;
    name: string;
    referenceNumber: string | null;
    /** Printed on the paper (D3). Never logged. */
    identityDocNumber: string | null;
  };
  property: RequestPropertyView | null;
  /** As `CitizenRequestListItem.fee`: null when no bill was raised and none will be. */
  fee: number | null;
  bill: RequestBillView | null;
  purpose: string | null;
  statement: string | null;
  rejectionReason: string | null;
  clearance: RequestClearanceSnapshot | null;
  attachments: RequestAttachmentView[];
  /** The form this request was filled on, with the version it kept (0113), or null for a request on no form. */
  form: RequestFormRef | null;
  /** Every answer, as stored, with where it came from (staff read them as `REQUEST_READ_ROLES`, F8). Empty on no form. */
  answers: RequestAnswerView[];
  /** The file questions of the form still holding no paper. */
  missingPapers: RequestMissingPaper[];
  /** The form's draft for the statement, which «جاهزة للاستلام» starts from (F9); never the certificate. Staff only. */
  statementTemplate: string | null;
  /** The form checks the property's dues before approval (F13): the panel shows them and the approval says so. Staff only. */
  requiresNoDues: boolean;
  createdByName: string | null;
  readyByName: string | null;
  createdAt: string;
  paidAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
}

/** A request as its citizen reads it in the portal: no statement, no staff names, no keys. */
export interface MyCitizenRequestView {
  id: string;
  requestNumber: string;
  status: RequestStatus;
  channel: RequestChannel;
  requestType: RequestType;
  /** Null when the request's form does not ask for it (0113); every request filed before forms has one. */
  applicantCapacity: ApplicantCapacity | null;
  property: RequestPropertyView | null;
  /** As `CitizenRequestListItem.fee`: null when no bill was raised and none will be. */
  fee: number | null;
  bill: RequestBillView | null;
  purpose: string | null;
  rejectionReason: string | null;
  attachments: RequestAttachmentView[];
  form: RequestFormRef | null;
  /** The citizen's own text answers, identity and civil numbers masked to their last three characters (F8). Never a paper. */
  answers: RequestAnswerView[];
  missingPapers: RequestMissingPaper[];
  /** The citizen still has to attach an identity paper before paying online (D2). */
  needsIdentityCopy: boolean;
  createdAt: string;
  readyAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
}

export interface SubmitRequestResult {
  id: string;
  requestNumber: string;
  status: RequestStatus;
  fee: number;
  /** An earlier press already filed it: this is that request, not a second one. */
  replayed: boolean;
}

export interface RaiseRequestBillResult {
  citizenPaymentId: string;
  invoiceNumber: string | null;
  amount: number;
  currency: string;
  /** The bill already existed: this is it, and no second one was raised. */
  existed: boolean;
}

export interface RequestAttachmentUrl {
  url: string;
  expiresInSeconds: number;
}
