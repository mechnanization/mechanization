'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, ReceiptText, X } from 'lucide-react';
import {
  APPLICANT_CAPACITY,
  getLabels,
  REQUEST_ATTACHMENT_TYPE,
  REQUEST_ATTACHMENTS_MAX,
  requestNeedsProperty,
  submitCounterRequestSchema,
  type ApplicantCapacity,
  type RequestAttachmentType,
  type RequestType,
} from '@mechanization/shared-schemas';
import { getCitizenProfile, logApiError, type CitizenProfileProperty } from '@/lib/api-client';
import { attachmentProblem, REQUEST_ATTACHMENT_ACCEPT, REQUEST_ATTACHMENT_MAX_MB } from '@/lib/request-attachments';
import {
  heldInDoubt,
  heldKey,
  keyIsSpent,
  markInDoubt,
  newRequestId,
  outcomeInDoubt,
  spendKey,
  type KeyScope,
} from '@/lib/request-id';
import { requestStatusBadge } from '@/lib/request-status';
import {
  raiseRequestBill,
  submitCounterRequest,
  uploadRequestAttachment,
  type RequestTypeSettingView,
  type SubmitRequestResult,
} from '@/lib/requests-api';
import { hasRole, PAYMENT_SETTLE_ROLES, REQUEST_BILL_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChoiceCard, Field } from '@/components/ui/field';
import { FileInput } from '@/components/ui/file-input';
import { Money } from '@/components/ui/money';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { CitizenPicker, type PickedCitizen } from '../citizen-picker';

/** A heading over a group of fields — the recording forms' own (BAN-4, TYP-5). */
function FormSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="border-b pb-1.5 text-xs font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** One request at a time from the counter: the key outlives the form (STA-4). */
const COUNTER_SCOPE: KeyScope = 'request:new';

/** A paper picked for the request, sent once the request exists. */
interface QueuedPaper {
  key: string;
  file: File;
  type: RequestAttachmentType;
}

/** What filing came back with, and how the papers went after it. */
interface Filed {
  result: SubmitRequestResult;
  sent: number;
  failed: Array<{ name: string; message: string }>;
}

/** The order the fields are read in, for the focus after a refusal (FRM-2). */
const FIELD_ORDER = ['citizenId', 'requestType', 'propertyEntryId', 'buildingUnitId', 'applicantCapacity', 'purpose'] as const;
const FIELD_ID: Record<(typeof FIELD_ORDER)[number], string> = {
  citizenId: 'counter-citizen',
  requestType: 'counter-type-first',
  propertyEntryId: 'counter-property-first',
  buildingUnitId: 'counter-unit',
  applicantCapacity: 'counter-capacity',
  purpose: 'counter-purpose',
};

/** The card's tenancy, read as the capacity the person most likely asks in. */
const CAPACITY_FROM_OCCUPANCY: Partial<Record<string, ApplicantCapacity>> = {
  OWNER: 'OWNER',
  TENANT: 'TENANT',
  FREE_OCCUPANT: 'FREE_OCCUPANT',
};

/**
 * «طلب جديد عند الشبّاك»: a clerk files a municipal request for a citizen who is
 * standing at the counter (open decisions §20 D8), with the papers they hand
 * over, scanned or photographed.
 *
 * The citizen is found on the register (`CitizenPicker`); the property comes
 * from the cards on their file that are still held (D4), never typed. The fee
 * is the manager's list's, shown and never edited here (D1). Filing raises no
 * bill: «تحصيل الرسم الآن» on the result does, when the person is ready to pay
 * (D10).
 *
 * The request is filed first and the papers sent after it, one at a time, each
 * on its own: a paper that fails is named on the result and added again from
 * the request's panel, and the request stands either way. The retry key is
 * held under `request:new` (`lib/request-id.ts`), so a lost answer and a second
 * press file the request once.
 */
export function CounterRequestForm({
  tenant,
  base,
  locale,
  token,
  role,
  types,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  role: string | undefined;
  /** The types the municipality offers now, with their fees. */
  types: RequestTypeSettingView[];
}): React.JSX.Element {
  const t = useTranslations('requests.form');
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const canBill = hasRole(REQUEST_BILL_ROLES, role);
  const canSettle = hasRole(PAYMENT_SETTLE_ROLES, role);

  const [citizen, setCitizen] = useState<PickedCitizen | null>(null);
  const [requestType, setRequestType] = useState<RequestType | ''>('');
  const [propertyEntryId, setPropertyEntryId] = useState('');
  const [buildingUnitId, setBuildingUnitId] = useState('');
  const [capacity, setCapacity] = useState<ApplicantCapacity | ''>('');
  const [purpose, setPurpose] = useState('');
  const [papers, setPapers] = useState<QueuedPaper[]>([]);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filed, setFiled] = useState<Filed | null>(null);
  const inFlight = useRef(false);
  const retrying = heldInDoubt(tenant, COUNTER_SCOPE);

  const profile = useStaffQuery({
    queryKey: ['citizen-profile', tenant, citizen?.id],
    queryFn: (accessToken) => getCitizenProfile(tenant, accessToken, citizen?.id as string),
    tenant,
    base,
    token: citizen ? token : null,
    errorMessage: t('profileError'),
  });

  /** The cards on the file that are still held: an ended tenancy is history, not something to certify. */
  const properties = useMemo<CitizenProfileProperty[]>(
    () => (profile.data?.registrations ?? []).flatMap((filing) => filing.properties).filter((card) => !card.endedAt),
    [profile.data],
  );
  const property = properties.find((card) => card.id === propertyEntryId);
  const units = (property?.units ?? []).filter((unit) => !unit.endedAt);
  const chosenType = types.find((setting) => setting.requestType === requestType);
  const needsProperty = requestType ? requestNeedsProperty(requestType) : false;

  const clear = (field: string) => setErrors(({ [field]: _cleared, ...rest }) => rest);

  const pickCitizen = (next: PickedCitizen | null) => {
    setCitizen(next);
    setPropertyEntryId('');
    setBuildingUnitId('');
    setCapacity('');
    clear('citizenId');
  };

  const pickProperty = (id: string) => {
    setPropertyEntryId(id);
    setBuildingUnitId('');
    const card = properties.find((entry) => entry.id === id);
    const suggested = card ? CAPACITY_FROM_OCCUPANCY[card.occupancyType] : undefined;
    // A suggestion fills an empty choice; it never overwrites one the clerk made.
    if (suggested && !capacity) setCapacity(suggested);
    clear('propertyEntryId');
  };

  const propertyLabel = (card: CitizenProfileProperty): string =>
    (labels.propertyType as Record<string, string>)[card.propertyType] ?? card.propertyType;

  // ── papers ────────────────────────────────────────────────────────────────────

  const addPapers = (files: File[]) => {
    setPaperError(null);
    const room = REQUEST_ATTACHMENTS_MAX - papers.length;
    const accepted: QueuedPaper[] = [];
    for (const file of files) {
      const problem = attachmentProblem(file);
      if (problem) {
        setPaperError(t(`fileProblem.${problem}`, { name: file.name, max: REQUEST_ATTACHMENT_MAX_MB }));
        continue;
      }
      if (accepted.length >= room) {
        setPaperError(t('papersFull', { max: REQUEST_ATTACHMENTS_MAX }));
        break;
      }
      const hasIdentity = [...papers, ...accepted].some((paper) => paper.type === 'IDENTITY');
      accepted.push({ key: newRequestId(), file, type: hasIdentity ? 'OTHER' : 'IDENTITY' });
    }
    if (accepted.length) setPapers((current) => [...current, ...accepted]);
  };

  // ── filing ────────────────────────────────────────────────────────────────────

  const focusFirst = (failed: Record<string, string>) => {
    const first = FIELD_ORDER.find((field) => failed[field]);
    if (first) document.getElementById(FIELD_ID[first])?.focus();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !token) return;
    setFormError(null);

    const parsed = submitCounterRequestSchema.safeParse({
      citizenId: citizen?.id,
      requestType: requestType || undefined,
      applicantCapacity: capacity || undefined,
      propertyEntryId: propertyEntryId || undefined,
      buildingUnitId: buildingUnitId || undefined,
      purpose,
      clientRequestId: heldKey(tenant, COUNTER_SCOPE),
    });
    if (!parsed.success) {
      const failed: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (field && !failed[field]) failed[field] = t(`required.${field}`);
      }
      setErrors(failed);
      focusFirst(failed);
      return;
    }
    setErrors({});

    inFlight.current = true;
    setSubmitting(true);
    let result: SubmitRequestResult;
    try {
      result = await submitCounterRequest(tenant, token, parsed.data);
    } catch (caught) {
      logApiError(caught);
      if (keyIsSpent(caught)) spendKey(tenant, COUNTER_SCOPE);
      else if (outcomeInDoubt(caught)) markInDoubt(tenant, COUNTER_SCOPE);
      setFormError(caught instanceof Error && caught.message ? caught.message : t('failed'));
      inFlight.current = false;
      setSubmitting(false);
      return;
    }
    // Filed: the next press is another request. The form stays locked behind the result.
    spendKey(tenant, COUNTER_SCOPE);
    void queryClient.invalidateQueries({ queryKey: ['requests', tenant] });
    setSubmitting(false);

    setUploading(true);
    const failed: Filed['failed'] = [];
    let sent = 0;
    for (const paper of papers) {
      try {
        await uploadRequestAttachment(tenant, token, {
          id: result.id,
          type: paper.type,
          file: paper.file,
          fileName: paper.file.name,
        });
        sent += 1;
      } catch (caught) {
        logApiError(caught);
        failed.push({
          name: paper.file.name,
          message: caught instanceof Error && caught.message ? caught.message : t('done.paperFailed'),
        });
      }
    }
    setUploading(false);
    setFiled({ result, sent, failed });
  };

  const startAnother = () => {
    inFlight.current = false;
    setFiled(null);
    setCitizen(null);
    setRequestType('');
    setPropertyEntryId('');
    setBuildingUnitId('');
    setCapacity('');
    setPurpose('');
    setPapers([]);
    setPaperError(null);
    setFormError(null);
  };

  if (filed) {
    return (
      <FiledCard
        filed={filed}
        tenant={tenant}
        base={base}
        locale={locale}
        token={token}
        canBill={canBill}
        onSettle={canSettle ? (paymentId) => router.push(`${base}/fees/payments/${paymentId}/settle`) : null}
        onAnother={startAnother}
      />
    );
  }

  const busy = submitting || uploading;

  return (
    <form noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start" onSubmit={submit}>
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <FormSection title={t('citizen')}>
          <CitizenPicker
            id={FIELD_ID.citizenId}
            tenant={tenant}
            token={token}
            value={citizen}
            onChange={pickCitizen}
            invalid={Boolean(errors.citizenId)}
          />
          {errors.citizenId ? <FieldError>{errors.citizenId}</FieldError> : null}
        </FormSection>

        <FormSection title={t('type')}>
          <div role="radiogroup" aria-label={t('type')} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {types.map((setting, index) => (
              <ChoiceCard
                key={setting.requestType}
                id={index === 0 ? FIELD_ID.requestType : undefined}
                name="counter-type"
                value={setting.requestType}
                checked={requestType === setting.requestType}
                onChange={(value) => {
                  setRequestType(value as RequestType);
                  clear('requestType');
                  clear('propertyEntryId');
                }}
                title={labels.requestType[setting.requestType]}
                description={
                  setting.feeAmount > 0 ? <Money amount={setting.feeAmount} locale={locale} exact /> : t('free')
                }
                className="min-h-touch"
              />
            ))}
          </div>
          {errors.requestType ? <FieldError>{errors.requestType}</FieldError> : null}
        </FormSection>

        <FormSection title={needsProperty ? t('propertyNeeded') : t('property')}>
          {!citizen ? (
            <p className="text-sm text-muted-foreground">{t('chooseCitizenFirst')}</p>
          ) : profile.loading ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : profile.error ? (
            <Alert variant="destructive" live="alert">
              {profile.error}{' '}
              <Button type="button" variant="link" className="h-auto p-0" onClick={profile.refetch}>
                {t('retry')}
              </Button>
            </Alert>
          ) : (
            <>
              {properties.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noCards')}</p>
              ) : null}
              {needsProperty && properties.length === 0 ? (
                <Alert variant="warning">{t('noCardsNeeded')}</Alert>
              ) : null}
              {properties.length > 0 || !needsProperty ? (
                <div role="radiogroup" aria-label={t('property')} className="grid gap-2 sm:grid-cols-2">
                  {!needsProperty ? (
                    <ChoiceCard
                      id={FIELD_ID.propertyEntryId}
                      name="counter-property"
                      value=""
                      checked={propertyEntryId === ''}
                      onChange={() => pickProperty('')}
                      title={t('noProperty')}
                      description={t('noPropertyHint')}
                      className="min-h-touch"
                    />
                  ) : null}
                  {properties.map((card, index) => (
                    <ChoiceCard
                      key={card.id}
                      id={needsProperty && index === 0 ? FIELD_ID.propertyEntryId : undefined}
                      name="counter-property"
                      value={card.id}
                      checked={propertyEntryId === card.id}
                      onChange={pickProperty}
                      title={propertyLabel(card)}
                      description={
                        <>
                          {card.propertyNumber ? (
                            <>
                              {t('propertyNumber')}{' '}
                              <bdi dir="ltr" className="font-mono">
                                {card.propertyNumber}
                              </bdi>
                            </>
                          ) : (
                            t('propertyNoNumber')
                          )}
                          {card.neighborhood ? ` · ${card.neighborhood}` : null}
                          {card.buildingName ? ` · ${card.buildingName}` : null}
                          {` · ${(labels.occupancyType as Record<string, string>)[card.occupancyType] ?? card.occupancyType}`}
                        </>
                      }
                      className="min-h-touch"
                    />
                  ))}
                </div>
              ) : null}
              {errors.propertyEntryId ? <FieldError>{errors.propertyEntryId}</FieldError> : null}

              {property && units.length > 0 ? (
                <Field htmlFor={FIELD_ID.buildingUnitId} label={t('unit')} optionalLabel={t('optional')}>
                  {/* Keyed on the card, so a unit cleared above is cleared in Radix too (docs/gotchas.md). */}
                  <Select
                    key={property.id}
                    value={buildingUnitId || 'WHOLE'}
                    onValueChange={(value) => setBuildingUnitId(value === 'WHOLE' ? '' : value)}
                  >
                    <SelectTrigger id={FIELD_ID.buildingUnitId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="WHOLE">{t('wholeProperty')}</SelectItem>
                      {units.map((unit) => (
                        <SelectItem key={unit.id} value={unit.id}>
                          {unit.unitCode ?? t('unitNoCode')}
                          {unit.floor ? ` · ${t('floor', { floor: unit.floor })}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </>
          )}
        </FormSection>

        <FormSection title={t('details')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor={FIELD_ID.applicantCapacity} label={t('capacity')} error={errors.applicantCapacity} required>
              <Select
                value={capacity}
                onValueChange={(value) => {
                  setCapacity(value as ApplicantCapacity);
                  clear('applicantCapacity');
                }}
              >
                <SelectTrigger id={FIELD_ID.applicantCapacity} aria-invalid={Boolean(errors.applicantCapacity)}>
                  <SelectValue placeholder={t('capacityPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {APPLICANT_CAPACITY.map((value) => (
                    <SelectItem key={value} value={value}>
                      {labels.applicantCapacity[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              htmlFor={FIELD_ID.purpose}
              label={t('purpose')}
              error={errors.purpose}
              optionalLabel={t('optional')}
              className="sm:col-span-2"
            >
              <Textarea
                id={FIELD_ID.purpose}
                rows={2}
                maxLength={500}
                value={purpose}
                placeholder={t('purposePlaceholder')}
                onChange={(event) => {
                  setPurpose(event.target.value);
                  clear('purpose');
                }}
              />
            </Field>
          </div>
        </FormSection>

        <FormSection title={t('papers')}>
          {papers.length > 0 ? (
            <ul className="divide-y rounded-lg border">
              {papers.map((paper) => (
                <li key={paper.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <bdi className="block truncate text-sm font-medium">{paper.file.name}</bdi>
                    <span className="block text-xs text-muted-foreground">
                      {t('size', { kb: Math.max(1, Math.round(paper.file.size / 1024)) })}
                    </span>
                  </span>
                  <Select
                    value={paper.type}
                    onValueChange={(value) =>
                      setPapers((current) =>
                        current.map((entry) =>
                          entry.key === paper.key ? { ...entry, type: value as RequestAttachmentType } : entry,
                        ),
                      )
                    }
                  >
                    {/* Its own line on a phone, so the file's name keeps the row; beside it from `sm`. */}
                    <SelectTrigger
                      className="order-last w-full sm:order-none sm:w-56"
                      aria-label={t('paperType', { name: paper.file.name })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REQUEST_ATTACHMENT_TYPE.map((value) => (
                        <SelectItem key={value} value={value}>
                          {labels.requestAttachmentType[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('removePaper', { name: paper.file.name })}
                    onClick={() => setPapers((current) => current.filter((entry) => entry.key !== paper.key))}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {papers.length < REQUEST_ATTACHMENTS_MAX ? (
            <FileInput
              id="counter-papers"
              accept={REQUEST_ATTACHMENT_ACCEPT}
              multiple
              disabled={busy}
              onSelect={addPapers}
              label={t('addPapers')}
              hint={t('fileHint', { max: REQUEST_ATTACHMENT_MAX_MB, count: REQUEST_ATTACHMENTS_MAX })}
            />
          ) : null}
          {paperError ? (
            <Alert variant="destructive" live="alert">
              {paperError}
            </Alert>
          ) : null}
        </FormSection>
      </fieldset>

      <aside className="lg:sticky lg:top-6">
        <Card>
          <CardContent className="space-y-3 p-4">
            <h2 className="text-sm font-semibold">{t('summaryTitle')}</h2>
            <SummaryList>
              <SummaryRow label={t('summaryCitizen')}>{citizen?.fullName ?? '—'}</SummaryRow>
              <SummaryRow label={t('summaryType')}>
                {requestType ? labels.requestType[requestType] : '—'}
              </SummaryRow>
              <SummaryRow label={t('summaryProperty')}>
                {property?.propertyNumber ? (
                  <bdi dir="ltr" className="font-mono">
                    {property.propertyNumber}
                  </bdi>
                ) : property ? (
                  propertyLabel(property)
                ) : (
                  '—'
                )}
              </SummaryRow>
              <SummaryRow label={t('summaryPapers')}>{papers.length}</SummaryRow>
              <SummaryRow label={t('summaryFee')}>
                {chosenType ? (
                  chosenType.feeAmount > 0 ? (
                    <Money amount={chosenType.feeAmount} locale={locale} exact />
                  ) : (
                    t('free')
                  )
                ) : (
                  '—'
                )}
              </SummaryRow>
            </SummaryList>
            {chosenType && chosenType.feeAmount > 0 ? (
              <p className="text-xs text-muted-foreground">{t('feeLater')}</p>
            ) : null}

            {retrying ? <Alert variant="warning">{t('retrying')}</Alert> : null}
            {formError ? (
              <Alert variant="destructive" live="alert">
                {formError}
              </Alert>
            ) : null}

            <Button type="submit" className="w-full" disabled={busy || !token}>
              {submitting ? t('submitting') : uploading ? t('uploading') : t('submit')}
            </Button>
          </CardContent>
        </Card>
      </aside>
    </form>
  );
}

/** A refusal under a group of choices, which has no `Field` of its own to carry it (CTL-12). */
function FieldError({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Alert variant="destructive" live="alert" className="py-2 text-xs">
      {children}
    </Alert>
  );
}

/**
 * What the counter sees once the request is filed: its number, where it
 * stands, how the papers went, and the next step — the fee, when there is one
 * and the person is ready to pay it.
 */
function FiledCard({
  filed,
  tenant,
  base,
  locale,
  token,
  canBill,
  onSettle,
  onAnother,
}: {
  filed: Filed;
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  canBill: boolean;
  /** Straight to the counter's settle page, for the cashier's roles; null names the invoice instead. */
  onSettle: ((paymentId: string) => void) | null;
  onAnother: () => void;
}): React.JSX.Element {
  const t = useTranslations('requests.form');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const { result, sent, failed } = filed;
  const [billing, setBilling] = useState(false);
  const [billError, setBillError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const billInFlight = useRef(false);
  const awaitingFee = result.status === 'AWAITING_PAYMENT' && result.fee > 0;

  const takeFee = async () => {
    if (!token || billInFlight.current) return;
    billInFlight.current = true;
    setBilling(true);
    setBillError(null);
    try {
      const bill = await raiseRequestBill(tenant, token, { id: result.id });
      void queryClient.invalidateQueries({ queryKey: ['requests', tenant] });
      if (onSettle) {
        onSettle(bill.citizenPaymentId);
        return;
      }
      setInvoice(bill.invoiceNumber ?? bill.citizenPaymentId);
    } catch (caught) {
      logApiError(caught);
      setBillError(caught instanceof Error && caught.message ? caught.message : t('done.actionFailed'));
    } finally {
      billInFlight.current = false;
      setBilling(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold">{result.replayed ? t('done.replayedTitle') : t('done.title')}</h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <bdi dir="ltr" className="font-mono text-base font-semibold">
              {result.requestNumber}
            </bdi>
            <Badge variant={requestStatusBadge(result.status)}>{labels.requestStatus[result.status]}</Badge>
          </p>
          {result.replayed ? <p className="text-sm text-muted-foreground">{t('done.replayed')}</p> : null}
        </div>

        <SummaryList>
          <SummaryRow label={t('summaryFee')}>
            {result.fee > 0 ? <Money amount={result.fee} locale={locale} exact /> : t('free')}
          </SummaryRow>
          <SummaryRow label={t('summaryPapers')}>{t('done.papersSent', { sent, total: sent + failed.length })}</SummaryRow>
        </SummaryList>

        {result.fee === 0 ? <p className="text-sm text-muted-foreground">{t('done.free')}</p> : null}

        {failed.length > 0 ? (
          <Alert variant="warning" title={t('done.papersFailed', { count: failed.length })}>
            <ul className="list-disc space-y-0.5 ps-4">
              {failed.map((paper, index) => (
                <li key={`${paper.name}-${index}`}>
                  <bdi>{paper.name}</bdi> — {paper.message}
                </li>
              ))}
            </ul>
            <p className="mt-1">{t('done.papersLater')}</p>
          </Alert>
        ) : null}

        {invoice ? (
          <Alert variant="info" live="status">
            {t.rich('done.billRaised', {
              number: invoice,
              code: (chunks) => (
                <bdi dir="ltr" className="font-mono">
                  {chunks}
                </bdi>
              ),
            })}
          </Alert>
        ) : null}
        {billError ? (
          <Alert variant="destructive" live="alert">
            {billError}
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {awaitingFee && canBill && !invoice ? (
            <Button type="button" onClick={() => void takeFee()} disabled={billing}>
              <ReceiptText className="size-4" aria-hidden />
              {billing ? t('done.billing') : t('done.takeFee')}
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href={`${base}/requests?request=${result.id}`}>{t('done.view')}</Link>
          </Button>
          <Button type="button" variant="outline" onClick={onAnother}>
            {t('done.another')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
