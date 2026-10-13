'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  approveRequestSchema,
  getLabels,
  municipalToday,
  rejectRequestSchema,
  type CitizenRequestView,
} from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import { formatDay } from '@/lib/dates';
import { approveRequest, cancelRequest, completeRequest, rejectRequest } from '@/lib/requests-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/**
 * The clerk's decisions on a municipal request, each a confirmation over the
 * request's panel (Radix stacks it on the Sheet). The server is the authority:
 * a refusal — the request moved since the panel was read, a براءة ذمة whose
 * property still owes — comes back translated and stays in the dialog
 * (`ConfirmDialog` shows a thrown error's message and stays open).
 */

interface DialogProps {
  tenant: string;
  token: string;
  locale: string;
  request: CitizenRequestView;
  onDone: (view: CitizenRequestView) => void;
  onCancel: () => void;
  /** A refusal: the request may have moved under the panel, which reads it again. */
  onFailed: () => void;
}

/** What a failed press says: the server's translated message, or this screen's own. */
function failure(caught: unknown, fallback: string): Error {
  logApiError(caught);
  return caught instanceof Error && caught.message ? caught : new Error(fallback);
}

/**
 * «جاهزة للاستلام»: the statement the paper will carry (open decisions §20 D3),
 * started from a sentence for the request's type that the clerk edits. For a
 * براءة ذمة the server checks what the property owes when this is confirmed.
 */
export function ApproveRequestDialog({ tenant, token, locale, request, onDone, onCancel, onFailed }: DialogProps) {
  const t = useTranslations('requests.dialogs');
  const labels = getLabels(locale);
  const propertyNumber = request.property?.propertyNumber ?? '—';
  const [statement, setStatement] = useState(() =>
    t(`approve.templates.${request.requestType}`, {
      name: request.citizen.name,
      property: propertyNumber,
      date: formatDay(municipalToday()),
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const confirm = async () => {
    if (inFlight.current) return;
    const parsed = approveRequestSchema.safeParse({ statement });
    if (!parsed.success) {
      setError(t('approve.statementRequired'));
      throw new Error(t('approve.statementRequired'));
    }
    setError(null);
    inFlight.current = true;
    try {
      onDone(await approveRequest(tenant, token, { id: request.id, statement: parsed.data.statement }));
    } catch (caught) {
      onFailed();
      throw failure(caught, t('failed'));
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('approve.title', { number: request.requestNumber })}
      description={
        request.requestType === 'CLEARANCE'
          ? t('approve.clearanceNote', { property: propertyNumber })
          : t('approve.description', { type: labels.requestType[request.requestType] })
      }
      confirmLabel={t('approve.confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    >
      <Field htmlFor="approve-statement" label={t('approve.statement')} error={error ?? undefined} required>
        <Textarea
          id="approve-statement"
          rows={5}
          maxLength={2000}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

/** «رفض الطلب», with the reason the citizen will read. A paid fee stays recorded (D5). */
export function RejectRequestDialog({ tenant, token, request, onDone, onCancel, onFailed }: DialogProps) {
  const t = useTranslations('requests.dialogs');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const paid = request.bill?.paymentStatus === 'PAID';

  const confirm = async () => {
    if (inFlight.current) return;
    const parsed = rejectRequestSchema.safeParse({ reason });
    if (!parsed.success) {
      setError(t('reject.reasonTooShort'));
      throw new Error(t('reject.reasonTooShort'));
    }
    setError(null);
    inFlight.current = true;
    try {
      onDone(await rejectRequest(tenant, token, { id: request.id, reason: parsed.data.reason }));
    } catch (caught) {
      onFailed();
      throw failure(caught, t('failed'));
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      title={t('reject.title', { number: request.requestNumber })}
      description={paid ? t('reject.paidNote') : t('reject.description')}
      confirmLabel={t('reject.confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    >
      <Field htmlFor="reject-reason" label={t('reject.reason')} error={error ?? undefined} required>
        <Textarea
          id="reject-reason"
          rows={3}
          maxLength={500}
          value={reason}
          placeholder={t('reject.reasonPlaceholder')}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

/** «تسليم المعاملة»: handed over against the original identity card. */
export function CompleteRequestDialog({ tenant, token, request, onDone, onCancel, onFailed }: DialogProps) {
  const t = useTranslations('requests.dialogs');
  const inFlight = useRef(false);
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      onDone(await completeRequest(tenant, token, { id: request.id }));
    } catch (caught) {
      onFailed();
      throw failure(caught, t('failed'));
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('complete.title', { number: request.requestNumber })}
      description={t('complete.description', { name: request.citizen.name })}
      confirmLabel={t('complete.confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    />
  );
}

/** «إلغاء الطلب», while no bill has been raised for it (D10). */
export function CancelRequestDialog({ tenant, token, request, onDone, onCancel, onFailed }: DialogProps) {
  const t = useTranslations('requests.dialogs');
  const inFlight = useRef(false);
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      onDone(await cancelRequest(tenant, token, { id: request.id }));
    } catch (caught) {
      onFailed();
      throw failure(caught, t('failed'));
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      title={t('cancelRequest.title', { number: request.requestNumber })}
      description={t('cancelRequest.description')}
      confirmLabel={t('cancelRequest.confirm')}
      cancelLabel={t('keep')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    />
  );
}
