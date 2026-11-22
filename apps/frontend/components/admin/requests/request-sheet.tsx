'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Printer, ReceiptText } from 'lucide-react';
import {
  getLabels,
  REQUEST_ATTACHMENT_TYPE,
  REQUEST_ATTACHMENTS_MAX,
  type RequestAttachmentType,
} from '@mechanization/shared-schemas';
import { ApiRequestError, getParcelDues, logApiError } from '@/lib/api-client';
import { formatDate, formatDateTime } from '@/lib/dates';
import { attachmentProblem, REQUEST_ATTACHMENT_ACCEPT, REQUEST_ATTACHMENT_MAX_MB } from '@/lib/request-attachments';
import { requestTitle } from '@/lib/request-title';
import { requestStatusBadge } from '@/lib/request-status';
import {
  getRequest,
  getRequestAttachmentUrl,
  raiseRequestBill,
  uploadRequestAttachment,
  type CitizenRequestView,
} from '@/lib/requests-api';
import { hasRole, PAYMENT_SETTLE_ROLES, REQUEST_BILL_ROLES, REQUEST_HANDLE_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileInput } from '@/components/ui/file-input';
import { Money } from '@/components/ui/money';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { formName } from '@/components/request-forms/form-renderer';
import { answerText, questionName } from '@/lib/request-form-display';
import {
  ApproveRequestDialog,
  CancelRequestDialog,
  CompleteRequestDialog,
  RejectRequestDialog,
} from './request-dialogs';

type Dialog = 'approve' | 'reject' | 'complete' | 'cancel' | null;

/**
 * A municipal request, opened from the queue: a side panel over it (`Sheet`,
 * the whole screen on a phone). Everything the clerk checks — who asked, in
 * what capacity, for which property, the fee and its bill, the papers — and,
 * in the footer, the one or two steps the request's status allows to the
 * reader's role:
 *
 *   - awaiting its fee, unbilled: «تحصيل الرسم» raises the bill and goes to the
 *     counter's settle page (the cashier's roles), or names the invoice to
 *     take to the cashier; «إلغاء الطلب».
 *   - awaiting its fee, billed: «تسجيل الدفع» on the settle page.
 *   - in review: «جاهزة للاستلام» with the statement the paper certifies, or
 *     «رفض الطلب» with its reason.
 *   - ready: the paper to print, and «تسليم المعاملة».
 *
 * The papers open in a new tab through a five-minute link the server audits;
 * the content security policy refuses them inline, and the portal never sees
 * them (open decisions §20 D6).
 */
export function RequestSheet({
  open,
  onClose,
  tenant,
  base,
  token,
  locale,
  role,
  requestId,
}: {
  open: boolean;
  onClose: () => void;
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  role: string | undefined;
  requestId: string;
}): React.JSX.Element {
  const t = useTranslations('requests.sheet');
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [billNotice, setBillNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [billing, setBilling] = useState(false);
  const billInFlight = useRef(false);

  // A confirmation left open when the panel closed (the back button) does not come back with it.
  useEffect(() => {
    if (open) return;
    setDialog(null);
    setActionError(null);
  }, [open]);

  const read = useStaffQuery<CitizenRequestView>({
    queryKey: ['requests', tenant, 'request', requestId],
    queryFn: (accessToken, signal) => getRequest(tenant, accessToken, { id: requestId }, signal),
    tenant,
    base,
    token: open ? token : null,
    errorMessage: t('loadError'),
  });
  const request = read.data;

  const canHandle = hasRole(REQUEST_HANDLE_ROLES, role);
  const canBill = hasRole(REQUEST_BILL_ROLES, role);
  const canSettle = hasRole(PAYMENT_SETTLE_ROLES, role);

  /** After a step: the panel and the queue read again. */
  const refresh = (view?: CitizenRequestView) => {
    if (view) queryClient.setQueryData(['requests', tenant, 'request', requestId], view);
    void queryClient.invalidateQueries({ queryKey: ['requests', tenant] });
  };

  const settleHref = (paymentId: string) => `${base}/fees/payments/${paymentId}/settle`;

  const takeFee = async () => {
    if (!token || !request || billInFlight.current) return;
    billInFlight.current = true;
    setBilling(true);
    setActionError(null);
    try {
      const bill = await raiseRequestBill(tenant, token, { id: request.id });
      refresh();
      if (canSettle) {
        router.push(settleHref(bill.citizenPaymentId));
        return;
      }
      setBillNotice(bill.invoiceNumber ?? bill.citizenPaymentId);
    } catch (caught) {
      logApiError(caught);
      setActionError(caught instanceof Error && caught.message ? caught.message : t('actionFailed'));
    } finally {
      billInFlight.current = false;
      setBilling(false);
    }
  };

  const title = request ? (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span>{requestTitle(request, locale, labels.requestType)}</span>
      <bdi dir="ltr" className="font-mono text-base font-medium">
        {request.requestNumber}
      </bdi>
    </span>
  ) : (
    t('title')
  );

  if (!request) {
    return (
      <Sheet open={open} onClose={onClose} title={title} closeLabel={t('close')} className="sm:max-w-lg">
        {read.error ? (
          <ErrorState title={read.error} onRetry={read.refetch} retryLabel={t('retry')} compact />
        ) : (
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </Sheet>
    );
  }

  const bill = request.bill;
  /** An online request is billed only once it carries an identity copy (D2); the server refuses before. */
  const needsIdentity = request.channel === 'ONLINE' && !request.attachments.some((paper) => paper.type === 'IDENTITY');
  const footer = (
    <div className="flex flex-wrap items-center gap-2">
      {request.status === 'AWAITING_PAYMENT' && !bill && canBill && (request.fee ?? 0) > 0 && !needsIdentity ? (
        <Button type="button" onClick={() => void takeFee()} disabled={billing}>
          <ReceiptText className="size-4" aria-hidden />
          {billing ? t('billing') : t('takeFee')}
        </Button>
      ) : null}
      {request.status === 'AWAITING_PAYMENT' && bill && bill.paymentStatus !== 'PAID' && canSettle ? (
        <Button asChild>
          <Link href={settleHref(bill.citizenPaymentId)}>
            <ReceiptText className="size-4" aria-hidden />
            {t('recordPayment')}
          </Link>
        </Button>
      ) : null}
      {request.status === 'IN_REVIEW' && canHandle ? (
        <>
          <Button type="button" onClick={() => setDialog('approve')}>
            {t('approve')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setDialog('reject')}>
            {t('reject')}
          </Button>
        </>
      ) : null}
      {request.status === 'READY_FOR_PICKUP' || request.status === 'COMPLETED' ? (
        <Button asChild variant="outline">
          <Link href={`${base}/requests/${request.id}/print?print=1`}>
            <Printer className="size-4" aria-hidden />
            {t('print')}
          </Link>
        </Button>
      ) : null}
      {request.status === 'READY_FOR_PICKUP' && canHandle ? (
        <Button type="button" onClick={() => setDialog('complete')}>
          {t('complete')}
        </Button>
      ) : null}
      {request.status === 'AWAITING_PAYMENT' && !bill && canHandle ? (
        <Button type="button" variant="ghost" className="ms-auto" onClick={() => setDialog('cancel')}>
          {t('cancel')}
        </Button>
      ) : null}
    </div>
  );

  const dialogProps = token
    ? {
        tenant,
        token,
        locale,
        request,
        onDone: (view: CitizenRequestView) => {
          setDialog(null);
          refresh(view);
        },
        onCancel: () => setDialog(null),
        // The dialog stays open with the refusal; behind it the panel reads the request again.
        onFailed: () => refresh(),
      }
    : null;

  return (
    <Sheet open={open} onClose={onClose} title={title} footer={footer} closeLabel={t('close')} className="sm:max-w-lg">
      <div className="space-y-5">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={requestStatusBadge(request.status)}>{labels.requestStatus[request.status]}</Badge>
          <Badge variant="soft-muted">{labels.requestChannel[request.channel]}</Badge>
          {request.status === 'REJECTED' && bill?.paymentStatus === 'PAID' ? (
            <Badge variant="soft-warning">{t('paidThenRejected')}</Badge>
          ) : null}
        </div>

        {actionError ? (
          <Alert variant="destructive" live="alert">
            {actionError}
          </Alert>
        ) : null}
        {request.status === 'AWAITING_PAYMENT' && !bill && needsIdentity ? (
          <Alert variant="warning">{t('needsIdentity')}</Alert>
        ) : null}
        {billNotice ? (
          <Alert variant="info" live="status" title={t('billRaised')}>
            {t.rich('billRaisedBody', {
              number: billNotice,
              code: (chunks) => (
                <bdi dir="ltr" className="font-mono">
                  {chunks}
                </bdi>
              ),
            })}
          </Alert>
        ) : null}

        <section className="space-y-2" aria-labelledby="request-applicant">
          <h3 id="request-applicant" className="text-sm font-semibold">
            {t('applicant')}
          </h3>
          <SummaryList>
            <SummaryRow label={t('citizen')}>
              <Link href={`${base}/citizens/${request.citizen.id}`} className="text-primary underline-offset-2 hover:underline">
                {request.citizen.name}
              </Link>
            </SummaryRow>
            <SummaryRow label={t('reference')} className="font-mono">
              <bdi dir="ltr">{request.citizen.referenceNumber ?? '—'}</bdi>
            </SummaryRow>
            <SummaryRow label={t('identityNumber')} className="font-mono">
              <bdi dir="ltr">{request.citizen.identityDocNumber ?? '—'}</bdi>
            </SummaryRow>
            {request.form ? (
              <SummaryRow label={t('form')}>
                {formName(request.form, locale)} <span className="text-xs text-muted-foreground">· {t('formVersion', { number: request.form.versionNumber })}</span>
              </SummaryRow>
            ) : null}
            {request.applicantCapacity ? (
              <SummaryRow label={t('capacity')}>{labels.applicantCapacity[request.applicantCapacity]}</SummaryRow>
            ) : null}
            {request.purpose ? <SummaryRow label={t('purpose')}>{request.purpose}</SummaryRow> : null}
          </SummaryList>
        </section>

        {request.answers.length > 0 ? (
          <section className="space-y-2" aria-labelledby="request-answers">
            <h3 id="request-answers" className="text-sm font-semibold">
              {t('answers')}
            </h3>
            <SummaryList>
              {request.answers.map((answer) => (
                <SummaryRow key={answer.fieldKey} label={locale === 'en' && answer.labelEn ? answer.labelEn : answer.labelAr}>
                  <span className="whitespace-pre-line">{answerText(answer, locale, t('yes'), t('no'))}</span>
                  {answer.origin === 'FROM_FILE' ? <span className="block text-xs text-muted-foreground">{t('answerFromFile')}</span> : null}
                </SummaryRow>
              ))}
            </SummaryList>
          </section>
        ) : null}

        {request.missingPapers.length > 0 && !['REJECTED', 'CANCELLED', 'COMPLETED'].includes(request.status) ? (
          <Alert variant="warning" title={t('missingPapers')}>
            {request.missingPapers.map((paper) => (locale === 'en' && paper.labelEn ? paper.labelEn : paper.labelAr)).join('، ')}
          </Alert>
        ) : null}

        {request.property ? (
          <section className="space-y-2" aria-labelledby="request-property">
            <h3 id="request-property" className="text-sm font-semibold">
              {t('property')}
            </h3>
            <SummaryList>
              <SummaryRow label={t('propertyNumber')} className="font-mono">
                <bdi dir="ltr">{request.property.propertyNumber ?? '—'}</bdi>
              </SummaryRow>
              <SummaryRow label={t('propertyType')}>{labels.propertyType[request.property.propertyType]}</SummaryRow>
              {request.property.neighborhood ? (
                <SummaryRow label={t('neighborhood')}>{request.property.neighborhood}</SummaryRow>
              ) : null}
              {request.property.buildingName ? (
                <SummaryRow label={t('building')}>{request.property.buildingName}</SummaryRow>
              ) : null}
              {request.property.unit ? (
                <SummaryRow label={t('unit')}>
                  <bdi dir="ltr" className="font-mono">
                    {request.property.unit.unitCode ?? '—'}
                  </bdi>
                  {request.property.unit.floor ? ` · ${t('floor', { floor: request.property.unit.floor })}` : null}
                </SummaryRow>
              ) : null}
            </SummaryList>
            {request.requiresNoDues && request.status === 'IN_REVIEW' && request.property.propertyNumber ? (
              <ParcelDuesNote
                tenant={tenant}
                base={base}
                token={token}
                locale={locale}
                propertyNumber={request.property.propertyNumber}
              />
            ) : null}
          </section>
        ) : null}

        <section className="space-y-2" aria-labelledby="request-fee">
          <h3 id="request-fee" className="text-sm font-semibold">
            {t('fee')}
          </h3>
          <SummaryList>
            <SummaryRow label={t('amount')}>
              {request.fee === null ? (
                '—'
              ) : request.fee > 0 ? (
                <Money amount={request.fee} locale={locale} exact />
              ) : (
                t('free')
              )}
            </SummaryRow>
            {bill ? (
              <>
                <SummaryRow label={t('invoice')} className="font-mono">
                  <bdi dir="ltr">{bill.invoiceNumber ?? '—'}</bdi>
                </SummaryRow>
                <SummaryRow label={t('billStatus')}>{labels.paymentStatus[bill.paymentStatus]}</SummaryRow>
                {bill.paidAmount > 0 && bill.paymentStatus !== 'PAID' ? (
                  <SummaryRow label={t('paidSoFar')}>
                    <Money amount={bill.paidAmount} locale={locale} exact />
                  </SummaryRow>
                ) : null}
              </>
            ) : (request.fee ?? 0) > 0 ? (
              // Only while it waits for its fee: a fee is shown without a bill for nothing else.
              <SummaryRow label={t('billStatus')}>{t('noBillYet')}</SummaryRow>
            ) : null}
          </SummaryList>
        </section>

        {request.statement || request.clearance ? (
          <section className="space-y-2" aria-labelledby="request-paper">
            <h3 id="request-paper" className="text-sm font-semibold">
              {t('paper')}
            </h3>
            {request.clearance ? (
              <p className="text-sm text-muted-foreground">
                {t('clearanceChecked', {
                  property: request.clearance.propertyNumber,
                  date: formatDateTime(request.clearance.checkedAt),
                })}
              </p>
            ) : null}
            {request.statement ? <p className="whitespace-pre-line text-sm">{request.statement}</p> : null}
          </section>
        ) : null}

        {request.rejectionReason ? (
          <Alert variant="destructive" title={t('rejectedBecause')}>
            {request.rejectionReason}
          </Alert>
        ) : null}

        <Papers
          tenant={tenant}
          token={token}
          locale={locale}
          request={request}
          canAdd={canHandle && ['AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP'].includes(request.status)}
          onAdded={() => refresh()}
        />

        <section className="space-y-2" aria-labelledby="request-timeline">
          <h3 id="request-timeline" className="text-sm font-semibold">
            {t('timeline')}
          </h3>
          <SummaryList>
            <SummaryRow label={t('filed')}>
              {formatDateTime(request.createdAt)}
              {request.createdByName ? ` · ${request.createdByName}` : null}
            </SummaryRow>
            {request.paidAt ? <SummaryRow label={t('paid')}>{formatDateTime(request.paidAt)}</SummaryRow> : null}
            {request.readyAt ? (
              <SummaryRow label={t('ready')}>
                {formatDateTime(request.readyAt)}
                {request.readyByName ? ` · ${request.readyByName}` : null}
              </SummaryRow>
            ) : null}
            {request.completedAt ? <SummaryRow label={t('completed')}>{formatDateTime(request.completedAt)}</SummaryRow> : null}
            {request.rejectedAt ? <SummaryRow label={t('rejected')}>{formatDateTime(request.rejectedAt)}</SummaryRow> : null}
            {request.cancelledAt ? <SummaryRow label={t('cancelled')}>{formatDateTime(request.cancelledAt)}</SummaryRow> : null}
          </SummaryList>
        </section>

        {dialogProps && dialog === 'approve' ? <ApproveRequestDialog {...dialogProps} /> : null}
        {dialogProps && dialog === 'reject' ? <RejectRequestDialog {...dialogProps} /> : null}
        {dialogProps && dialog === 'complete' ? <CompleteRequestDialog {...dialogProps} /> : null}
        {dialogProps && dialog === 'cancel' ? <CancelRequestDialog {...dialogProps} /> : null}
      </div>
    </Sheet>
  );
}

/**
 * Before a براءة ذمة is approved: what the property owes now, so the clerk
 * knows whether «جاهزة للاستلام» will be refused. The server checks again on
 * approval; this is only the forecast.
 */
function ParcelDuesNote({
  tenant,
  base,
  token,
  locale,
  propertyNumber,
}: {
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  propertyNumber: string;
}) {
  const t = useTranslations('requests.sheet');
  const dues = useStaffQuery({
    queryKey: ['fees', tenant, 'parcel-dues', propertyNumber],
    queryFn: (accessToken, signal) => getParcelDues(tenant, accessToken, propertyNumber, signal),
    tenant,
    base,
    token,
    errorMessage: t('duesError'),
  });
  if (dues.loading) return <Skeleton className="h-10 w-full" />;
  if (dues.error || !dues.data) {
    return (
      <Alert variant="warning" live="status">
        {dues.error ?? t('duesError')}
      </Alert>
    );
  }
  return dues.data.total > 0 ? (
    <Alert variant="warning" live="status" title={t('duesOwed')}>
      <span className="flex flex-wrap items-baseline gap-1">
        {t('duesOwedBody')} <Money amount={dues.data.total} locale={locale} exact />
      </span>
    </Alert>
  ) : (
    <Alert variant="success" live="status">
      {dues.data.unlinkedTotal > 0 ? t('duesClearUnlinked') : t('duesClear')}
    </Alert>
  );
}

/** The papers on the request, each opened in a new tab; staff may add one while the request is open. */
function Papers({
  tenant,
  token,
  locale,
  request,
  canAdd,
  onAdded,
}: {
  tenant: string;
  token: string | null;
  locale: string;
  request: CitizenRequestView;
  canAdd: boolean;
  onAdded: () => void;
}) {
  const t = useTranslations('requests.sheet');
  const labels = getLabels(locale);
  // The paper the request is missing comes first: a question of its form still holding none, else an online request's
  // identity copy (D2). A target is `q:<key>` for a question and `t:<TYPE>` for a kind of paper.
  const [target, setTarget] = useState<string>(() => {
    if (request.missingPapers[0]) return `q:${request.missingPapers[0].fieldKey}`;
    return request.channel === 'ONLINE' && !request.attachments.some((paper) => paper.type === 'IDENTITY') ? 't:IDENTITY' : 't:OTHER';
  });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const full = request.attachments.length >= REQUEST_ATTACHMENTS_MAX;

  const openPaper = async (attachmentId: string) => {
    if (!token) return;
    setOpening(attachmentId);
    setError(null);
    try {
      const { url } = await getRequestAttachmentUrl(tenant, token, { id: request.id, attachmentId });
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof Error && caught.message ? caught.message : t('openFailed'));
    } finally {
      setOpening(null);
    }
  };

  const add = async (files: File[]) => {
    const file = files[0];
    if (!file || !token) return;
    const problem = attachmentProblem(file);
    if (problem) {
      setError(t(`fileProblem.${problem}`, { max: REQUEST_ATTACHMENT_MAX_MB }));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      await uploadRequestAttachment(
        tenant,
        token,
        target.startsWith('q:')
          ? { id: request.id, fieldKey: target.slice(2), file, fileName: file.name }
          : { id: request.id, type: target.slice(2) as RequestAttachmentType, file, fileName: file.name },
      );
      onAdded();
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError && caught.status === 413
          ? t('fileProblem.TOO_LARGE', { max: REQUEST_ATTACHMENT_MAX_MB })
          : caught instanceof Error && caught.message
            ? caught.message
            : t('uploadFailed'),
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="space-y-2" aria-labelledby="request-papers">
      <h3 id="request-papers" className="text-sm font-semibold">
        {t('papers', { count: request.attachments.length })}
      </h3>
      {request.attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noPapers')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {request.attachments.map((paper) => (
            <li key={paper.id} className="flex items-center gap-3 px-3 py-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {paper.fieldLabelAr ? (locale === 'en' && paper.fieldLabelEn ? paper.fieldLabelEn : paper.fieldLabelAr) : labels.requestAttachmentType[paper.type]}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatDate(paper.createdAt)} · {paper.uploadedByKind === 'CITIZEN' ? t('byCitizen') : t('byStaff')}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={opening === paper.id}
                aria-label={t('openPaper', { type: labels.requestAttachmentType[paper.type] })}
                onClick={() => void openPaper(paper.id)}
              >
                <ExternalLink className="size-3.5" aria-hidden />
                {t('open')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <Alert variant="destructive" live="alert">
          {error}
        </Alert>
      ) : null}
      {canAdd && !full ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger aria-label={t('paperType')}>
              <SelectValue>
                {target.startsWith('q:')
                  ? questionName(request.missingPapers.find((paper) => `q:${paper.fieldKey}` === target), locale)
                  : labels.requestAttachmentType[target.slice(2) as RequestAttachmentType]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {request.missingPapers.map((paper) => (
                <SelectItem key={`q:${paper.fieldKey}`} value={`q:${paper.fieldKey}`}>
                  {questionName(paper, locale)}
                </SelectItem>
              ))}
              {REQUEST_ATTACHMENT_TYPE.map((value) => (
                <SelectItem key={value} value={`t:${value}`}>
                  {labels.requestAttachmentType[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FileInput
            id={`request-paper-${request.id}`}
            accept={REQUEST_ATTACHMENT_ACCEPT}
            disabled={uploading}
            onSelect={(files) => void add(files)}
            label={uploading ? t('uploading') : t('addPaper')}
            hint={t('fileHint', { max: REQUEST_ATTACHMENT_MAX_MB })}
          />
        </div>
      ) : null}
    </section>
  );
}
