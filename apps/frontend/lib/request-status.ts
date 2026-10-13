import type { RequestStatus } from '@mechanization/shared-schemas';

/**
 * How a municipal request's status reads on screen: one tone per status, for a
 * `CellTag` in a table column (PRIM-8) and a `soft-*` `Badge` as an annotation
 * (PRIM-9), so the queue, the panel and the portal colour it alike. The word
 * always goes beside the colour (COL-3): these pick the colour, the labels
 * (`getLabels(locale).requestStatus`) give the word.
 *
 * Waiting on the citizen's fee is the warning; in the clerk's hands is the
 * primary; ready to collect is the success; a rejection is destructive; done
 * and cancelled are quiet.
 */
export type RequestStatusTone = 'warning' | 'primary' | 'success' | 'destructive' | 'neutral' | 'muted';

const TONE: Record<RequestStatus, RequestStatusTone> = {
  AWAITING_PAYMENT: 'warning',
  IN_REVIEW: 'primary',
  READY_FOR_PICKUP: 'success',
  COMPLETED: 'neutral',
  REJECTED: 'destructive',
  CANCELLED: 'muted',
};

export function requestStatusTone(status: RequestStatus): RequestStatusTone {
  return TONE[status];
}

export type RequestStatusBadge = 'soft-warning' | 'soft-info' | 'soft-success' | 'soft-destructive' | 'soft-default' | 'soft-muted';

const BADGE: Record<RequestStatusTone, RequestStatusBadge> = {
  warning: 'soft-warning',
  primary: 'soft-info',
  success: 'soft-success',
  destructive: 'soft-destructive',
  neutral: 'soft-default',
  muted: 'soft-muted',
};

export function requestStatusBadge(status: RequestStatus): RequestStatusBadge {
  return BADGE[TONE[status]];
}
