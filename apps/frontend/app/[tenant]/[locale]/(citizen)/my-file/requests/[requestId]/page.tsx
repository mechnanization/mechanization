'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, CreditCard, FileText, Loader2 } from 'lucide-react';
import {
  getLabels,
  REQUEST_ATTACHMENT_TYPE,
  REQUEST_ATTACHMENTS_MAX,
  REQUEST_STATUSES_TAKING_ATTACHMENTS,
  type RequestAttachmentType,
} from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, startWhishCheckout } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { compressPaper } from '@/lib/image-compression';
import { ONLINE_PAYMENT_OPEN, onlineCopy } from '@/lib/online-payment';
import { attachmentProblem, REQUEST_ATTACHMENT_ACCEPT, REQUEST_ATTACHMENT_MAX_MB } from '@/lib/request-attachments';
import { requestStatusBadge } from '@/lib/request-status';
import {
  cancelMyRequest,
  getMyRequest,
  raiseMyRequestBill,
  uploadMyRequestAttachment,
  type MyCitizenRequestView,
} from '@/lib/requests-api';
import { useCitizenSession } from '@/lib/use-citizen-session';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FileInput } from '@/components/ui/file-input';
import { Money } from '@/components/ui/money';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';

/**
 * One of the citizen's requests, on its own page: where it stands and what is
 * theirs to do next — attach their identity copy (D2), pay the fee (at the
 * municipality's cash office while online payment is paused,
 * `lib/online-payment.ts`; «ادفع الآن» online once it reopens), cancel it while
 * nothing is billed (D10), or come in for a paper that is ready with their
 * original identity card.
 *
 * The papers are listed by type and date, never served back (D6): the portal
 * holds no link to an identity copy, so a borrowed session cannot read one. A
 * rejected request says why, in the clerk's words, and that a paid fee is not
 * returned on its own (D5). The statement a paper certifies is the clerk's and
 * appears on the paper, not here.
 */
export default function MyRequestPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; requestId: string }>;
}) {
  const { tenant, locale, requestId } = use(params);
  const base = `/${tenant}/${locale}`;
  const t = useTranslations('citizenRequests.detail');
  const labels = getLabels(locale);
  const searchParams = useSearchParams();
  const justFiled = searchParams.get('filed') === '1';
  const failedPapers = Number(searchParams.get('failed') ?? '0') || 0;
  const { token, endIfSignedOut } = useCitizenSession(tenant, base);

  const [request, setRequest] = useState<MyCitizenRequestView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const payInFlight = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        setRequest(await getMyRequest(tenant, token, { id: requestId }, signal));
        setLoadError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        logApiError(caught);
        if (endIfSignedOut(caught)) return;
        setLoadError(
          caught instanceof ApiRequestError && caught.code === 'REQUEST_NOT_FOUND' ? t('notFound') : t('loadError'),
        );
      }
    },
    [tenant, token, requestId, endIfSignedOut, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * «ادفع الآن»: the fee's bill, raised or answered, then Whish's checkout. Not
   * offered while online payment is paused (`ONLINE_PAYMENT_OPEN`), and the
   * server refuses both steps for a citizen until the gateway is live.
   */
  const pay = async () => {
    if (!token || !request || payInFlight.current) return;
    payInFlight.current = true;
    setPaying(true);
    setActionError(null);
    try {
      const bill = await raiseMyRequestBill(tenant, token, { id: request.id });
      const { redirectUrl } = await startWhishCheckout(tenant, token, bill.citizenPaymentId);
      window.location.href = redirectUrl;
    } catch (caught) {
      logApiError(caught);
      if (endIfSignedOut(caught)) return;
      setActionError(caught instanceof Error && caught.message ? caught.message : t('payFailed'));
      payInFlight.current = false;
      setPaying(false);
      // The bill may have been raised before the checkout failed: the page reads it again.
      void load();
    }
  };

  const Back = locale === 'en' ? ArrowLeft : ArrowRight;
  /**
   * «ادفع الآن»: not while online payment is paused (lib/online-payment.ts) — the fee is paid at
   * the municipality — nor while an identity copy is missing or a payment is being checked.
   */
  const canPay =
    ONLINE_PAYMENT_OPEN &&
    request?.status === 'AWAITING_PAYMENT' &&
    (request.fee ?? 0) > 0 &&
    !request.needsIdentityCopy &&
    request.bill?.paymentStatus !== 'PENDING_REVIEW';
  /** «إلغاء الطلب», while no bill has been raised (D10). */
  const canCancel = request?.status === 'AWAITING_PAYMENT' && !request.bill;

  if (!token) return null;

  return (
    <div className="space-y-6">
      <Link
        href={`${base}/my-file`}
        className="inline-flex min-h-touch items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Back className="size-4" aria-hidden />
        {t('back')}
      </Link>

      {loadError ? (
        <div className="space-y-3">
          <Alert variant="destructive" live="alert">
            {loadError}
          </Alert>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : !request ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">{labels.requestType[request.requestType]}</h1>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <bdi dir="ltr" className="font-mono font-semibold">
                {request.requestNumber}
              </bdi>
              <Badge variant={requestStatusBadge(request.status)}>{labels.requestStatus[request.status]}</Badge>
            </p>
          </div>

          {justFiled ? (
            <Alert variant="success" live="status" title={t('filedTitle')}>
              {failedPapers > 0 ? t('filedPapersFailed', { count: failedPapers }) : t('filedBody')}
            </Alert>
          ) : null}

          <StatusNote request={request} />

          {actionError ? (
            <Alert variant="destructive" live="alert">
              {actionError}
            </Alert>
          ) : null}

          {canPay || canCancel ? (
            <div className="flex flex-wrap gap-2">
              {canPay ? (
                <Button type="button" onClick={() => void pay()} disabled={paying}>
                  {paying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CreditCard className="size-4" aria-hidden />}
                  {paying ? t('paying') : t('pay')}
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" variant="outline" onClick={() => setCancelling(true)} disabled={paying}>
                  {t('cancel')}
                </Button>
              ) : null}
            </div>
          ) : null}

          <Card>
            <CardContent className="p-4 sm:p-6">
              <SummaryList>
                <SummaryRow label={t('capacity')}>{labels.applicantCapacity[request.applicantCapacity]}</SummaryRow>
                <SummaryRow label={t('property')}>
                  {request.property ? (
                    <>
                      {labels.propertyType[request.property.propertyType]}
                      {request.property.propertyNumber ? (
                        <>
                          {' '}
                          <bdi dir="ltr" className="font-mono">
                            {request.property.propertyNumber}
                          </bdi>
                        </>
                      ) : null}
                      {request.property.unit?.unitCode ? (
                        <>
                          {' · '}
                          <bdi dir="ltr" className="font-mono">
                            {request.property.unit.unitCode}
                          </bdi>
                        </>
                      ) : null}
                    </>
                  ) : (
                    t('noProperty')
                  )}
                </SummaryRow>
                {request.purpose ? <SummaryRow label={t('purpose')}>{request.purpose}</SummaryRow> : null}
                <SummaryRow label={t('channel')}>{labels.requestChannel[request.channel]}</SummaryRow>
                <SummaryRow label={t('filed')}>{formatDate(request.createdAt)}</SummaryRow>
                <SummaryRow label={t('fee')}>
                  {request.fee === null ? (
                    '—'
                  ) : request.fee > 0 ? (
                    <Money amount={request.fee} locale={locale} exact />
                  ) : (
                    t('free')
                  )}
                </SummaryRow>
                {request.bill ? (
                  <SummaryRow label={t('billStatus')}>
                    {labels.paymentStatus[request.bill.paymentStatus]}
                    {request.bill.invoiceNumber ? (
                      <>
                        {' · '}
                        <bdi dir="ltr" className="font-mono">
                          {request.bill.invoiceNumber}
                        </bdi>
                      </>
                    ) : null}
                  </SummaryRow>
                ) : null}
              </SummaryList>
            </CardContent>
          </Card>

          <Papers
            request={request}
            tenant={tenant}
            token={token}
            locale={locale}
            onAdded={() => void load()}
            onSignedOut={endIfSignedOut}
          />

          {cancelling ? (
            <ConfirmDialog
              open
              onOpenChange={(open) => (open ? undefined : setCancelling(false))}
              title={t('cancelTitle', { number: request.requestNumber })}
              description={t('cancelBody')}
              confirmLabel={t('cancelConfirm')}
              cancelLabel={t('keep')}
              busyLabel={t('cancelling')}
              onConfirm={async () => {
                try {
                  setRequest(await cancelMyRequest(tenant, token, { id: request.id }));
                  setCancelling(false);
                } catch (caught) {
                  logApiError(caught);
                  if (endIfSignedOut(caught)) return;
                  throw caught instanceof Error && caught.message ? caught : new Error(t('cancelFailed'));
                }
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** Where the request stands, in a sentence, and what is the citizen's to do. */
function StatusNote({ request }: { request: MyCitizenRequestView }): React.JSX.Element | null {
  const t = useTranslations('citizenRequests.detail.status');
  switch (request.status) {
    case 'AWAITING_PAYMENT':
      if (request.needsIdentityCopy) return <Alert variant="warning">{t('needsIdentity', onlineCopy())}</Alert>;
      if (request.bill?.paymentStatus === 'PENDING_REVIEW') return <Alert variant="info">{t('paymentPending')}</Alert>;
      return <Alert variant="info">{t('awaitingPayment', onlineCopy())}</Alert>;
    case 'IN_REVIEW':
      return <Alert variant="info">{t('inReview')}</Alert>;
    case 'READY_FOR_PICKUP':
      return (
        <Alert variant="success" title={t('readyTitle')}>
          {t('ready')}
        </Alert>
      );
    case 'COMPLETED':
      return <Alert variant="success">{t('completed', { date: request.completedAt ? formatDate(request.completedAt) : '—' })}</Alert>;
    case 'REJECTED':
      return (
        <Alert variant="destructive" title={t('rejectedTitle')}>
          <p className="whitespace-pre-line">{request.rejectionReason ?? '—'}</p>
          {request.bill?.paymentStatus === 'PAID' ? <p className="mt-1">{t('rejectedPaid')}</p> : null}
        </Alert>
      );
    case 'CANCELLED':
      return <Alert variant="info">{t('cancelled')}</Alert>;
    default:
      return null;
  }
}

/**
 * The papers on the request, by type and date — never their content (D6) —
 * and, while the request is still being prepared or read, a way to add one:
 * the identity copy first when it is missing.
 */
function Papers({
  request,
  tenant,
  token,
  locale,
  onAdded,
  onSignedOut,
}: {
  request: MyCitizenRequestView;
  tenant: string;
  token: string;
  locale: string;
  onAdded: () => void;
  onSignedOut: (caught: unknown) => boolean;
}): React.JSX.Element {
  const t = useTranslations('citizenRequests.detail');
  const labels = getLabels(locale);
  const [type, setType] = useState<RequestAttachmentType>(request.needsIdentityCopy ? 'IDENTITY' : 'OTHER');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = (REQUEST_STATUSES_TAKING_ATTACHMENTS as readonly string[]).includes(request.status);
  const room = request.attachments.length < REQUEST_ATTACHMENTS_MAX;

  // The identity copy is what the fee waits for: once it is missing, it is the paper offered.
  useEffect(() => {
    if (request.needsIdentityCopy) setType('IDENTITY');
  }, [request.needsIdentityCopy]);

  const add = async (files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    setError(null);
    setUploading(true);
    try {
      const file = await compressPaper(picked);
      const problem = attachmentProblem(file);
      if (problem) {
        setError(t(`fileProblem.${problem}`, { name: picked.name, max: REQUEST_ATTACHMENT_MAX_MB }));
        return;
      }
      await uploadMyRequestAttachment(tenant, token, { id: request.id, type, file, fileName: file.name });
      onAdded();
    } catch (caught) {
      logApiError(caught);
      if (onSignedOut(caught)) return;
      setError(
        caught instanceof ApiRequestError && caught.status === 413
          ? t('fileProblem.TOO_LARGE', { name: picked.name, max: REQUEST_ATTACHMENT_MAX_MB })
          : caught instanceof Error && caught.message
            ? caught.message
            : t('uploadFailed'),
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="my-request-papers">
      <h2 id="my-request-papers" className="text-lg font-semibold">
        {t('papers', { count: request.attachments.length })}
      </h2>
      {request.attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noPapers')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {request.attachments.map((paper) => (
            <li key={paper.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 text-sm font-medium">{labels.requestAttachmentType[paper.type]}</span>
              <span className="text-xs text-muted-foreground">{formatDate(paper.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && room ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <Select value={type} onValueChange={(value) => setType(value as RequestAttachmentType)}>
            <SelectTrigger aria-label={t('paperType')}>
              <SelectValue>{labels.requestAttachmentType[type]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {REQUEST_ATTACHMENT_TYPE.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.requestAttachmentType[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FileInput
            id={`my-request-paper-${request.id}`}
            accept={REQUEST_ATTACHMENT_ACCEPT}
            disabled={uploading}
            onSelect={(files) => void add(files)}
            label={uploading ? t('uploading') : t('addPaper')}
            hint={t('fileHint', { max: REQUEST_ATTACHMENT_MAX_MB })}
          />
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive" live="alert">
          {error}
        </Alert>
      ) : null}
    </section>
  );
}
