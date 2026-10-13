import { z } from 'zod';
import {
  applicantCapacitySchema,
  requestAttachmentTypeSchema,
  requestChannelSchema,
  requestStatusSchema,
  requestTypeSchema,
  type ApplicantCapacity,
  type PropertyType,
  type RequestAttachmentType,
  type RequestChannel,
  type RequestStatus,
  type RequestType,
} from './enums';

/**
 * المعاملات والإفادات — a citizen asks the municipality for a paper, pays its fee,
 * and collects the stamped paper at the counter. Design:
 * docs/municipal-requests-plan.md; the decisions: docs/open-decisions.md §20;
 * the tables: tenant migration 0092.
 */

// ─── rules both apps read ───

/**
 * The types tied to a property: the request names one of the citizen's cards
 * (open decisions §20 D4). A residence certificate and a general request may
 * name one, and need not.
 */
export const REQUEST_TYPES_ON_PROPERTY = [
  'CLEARANCE',
  'OCCUPANCY',
  'VACANCY',
  'LEASE_REGISTRATION',
  'RENOVATION',
  'SIGNAGE',
] as const satisfies readonly RequestType[];

export function requestNeedsProperty(type: RequestType): boolean {
  return (REQUEST_TYPES_ON_PROPERTY as readonly RequestType[]).includes(type);
}

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

const uuid = (message: string) => z.string({ required_error: message }).uuid(message);

const requestFields = {
  requestType: requestTypeSchema,
  applicantCapacity: applicantCapacitySchema,
  propertyEntryId: uuid('اختر العقار').optional(),
  buildingUnitId: uuid('اختر الوحدة').optional(),
  purpose: z
    .string()
    .trim()
    .max(500, 'الغرض طويل جداً')
    .optional()
    .transform((value) => (value ? value : undefined)),
  clientRequestId: z.string().uuid(),
};

/** A type tied to a property names a card; a unit line is always on a card. */
function requestShape(
  value: { requestType: RequestType; propertyEntryId?: string; buildingUnitId?: string },
  context: z.RefinementCtx,
): void {
  if (requestNeedsProperty(value.requestType) && !value.propertyEntryId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['propertyEntryId'], message: 'اختر العقار' });
  }
  if (value.buildingUnitId && !value.propertyEntryId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['propertyEntryId'], message: 'اختر العقار' });
  }
}

/** «إرسال الطلب» in the portal — the citizen is the token's (`POST requests/mine`). */
export const submitOnlineRequestSchema = z.object(requestFields).superRefine(requestShape);
export type SubmitOnlineRequestInput = z.infer<typeof submitOnlineRequestSchema>;

/** A request filed by a clerk at the counter for a citizen who is present (`POST requests`). */
export const submitCounterRequestSchema = z
  .object({ ...requestFields, citizenId: uuid('اختر المواطن') })
  .superRefine(requestShape);
export type SubmitCounterRequestInput = z.infer<typeof submitCounterRequestSchema>;

/** «جاهزة للاستلام»: what the paper certifies, in the clerk's words (open decisions §20 D3). */
export const approveRequestSchema = z.object({
  statement: z
    .string({ required_error: 'اكتب نصّ الإفادة' })
    .trim()
    .min(5, 'اكتب نصّ الإفادة')
    .max(2000, 'النصّ طويل جداً'),
});
export type ApproveRequestInput = z.infer<typeof approveRequestSchema>;

/** «رفض الطلب», with the reason the citizen will read. */
export const rejectRequestSchema = z.object({
  reason: z
    .string({ required_error: 'اكتب سبب الرفض' })
    .trim()
    .min(5, 'اكتب سبب الرفض (٥ أحرف على الأقل)')
    .max(500, 'السبب طويل جداً'),
});
export type RejectRequestInput = z.infer<typeof rejectRequestSchema>;

/** The manager's list of request types: switched on or off, and the fee in whole pounds (D1). */
export const updateRequestTypeSettingSchema = z.object({
  enabled: z.boolean(),
  feeAmount: z.coerce
    .number({ invalid_type_error: 'الرسم يجب أن يكون رقماً' })
    .int('الرسم بالليرة، رقماً صحيحاً')
    .min(0, 'الرسم لا يكون سالباً')
    .max(1_000_000_000, 'الرسم كبير جداً — يرجى المراجعة'),
});
export type UpdateRequestTypeSettingInput = z.infer<typeof updateRequestTypeSettingSchema>;

/** The text field sent beside the file (`multipart/form-data`). */
export const uploadRequestAttachmentSchema = z.object({ type: requestAttachmentTypeSchema });
export type UploadRequestAttachmentInput = z.infer<typeof uploadRequestAttachmentSchema>;

/** The staff queue (`GET requests`). */
export const listRequestsQuerySchema = z.object({
  status: requestStatusSchema.optional(),
  channel: requestChannelSchema.optional(),
  type: requestTypeSchema.optional(),
  search: z.string().trim().max(120).optional().transform((value) => (value ? value : undefined)),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;

// ─── response shapes ───

/** One line of the manager's list of request types. */
export interface RequestTypeSettingView {
  requestType: RequestType;
  enabled: boolean;
  /** Whole pounds; 0 is free. */
  feeAmount: number;
  needsProperty: boolean;
  updatedAt: string | null;
}

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
  citizenId: string;
  citizenName: string;
  propertyNumber: string | null;
  /** The fee: the bill's amount once raised, the type's current fee before. */
  fee: number;
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
  applicantCapacity: ApplicantCapacity;
  citizen: {
    id: string;
    name: string;
    referenceNumber: string | null;
    /** Printed on the paper (D3). Never logged. */
    identityDocNumber: string | null;
  };
  property: RequestPropertyView | null;
  fee: number;
  bill: RequestBillView | null;
  purpose: string | null;
  statement: string | null;
  rejectionReason: string | null;
  clearance: RequestClearanceSnapshot | null;
  attachments: RequestAttachmentView[];
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
  applicantCapacity: ApplicantCapacity;
  property: RequestPropertyView | null;
  fee: number;
  bill: RequestBillView | null;
  purpose: string | null;
  rejectionReason: string | null;
  attachments: RequestAttachmentView[];
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
