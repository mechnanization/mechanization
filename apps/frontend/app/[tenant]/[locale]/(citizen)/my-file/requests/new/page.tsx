'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, FileText, Loader2, X } from 'lucide-react';
import {
  APPLICANT_CAPACITY,
  getLabels,
  REQUEST_ATTACHMENT_TYPE,
  REQUEST_ATTACHMENTS_MAX,
  requestNeedsProperty,
  submitOnlineRequestSchema,
  type ApplicantCapacity,
  type RequestAttachmentType,
  type RequestType,
} from '@mechanization/shared-schemas';
import { getMySummary, logApiError, type CitizenProfileProperty } from '@/lib/api-client';
import { compressPaper } from '@/lib/image-compression';
import { onlineCopy } from '@/lib/online-payment';
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
import {
  getOfferedRequestTypes,
  submitMyRequest,
  uploadMyRequestAttachment,
  type RequestTypeSettingView,
} from '@/lib/requests-api';
import { param } from '@/lib/url-state';
import { useCitizenSession } from '@/lib/use-citizen-session';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChoiceCard, Field } from '@/components/ui/field';
import { FileInput } from '@/components/ui/file-input';
import { Money } from '@/components/ui/money';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';

const STEPS = ['type', 'property', 'papers', 'review'] as const;
type Step = (typeof STEPS)[number];
const URL_STATE = { step: param.oneOf(STEPS, 'type') };

/** A paper picked in the wizard, sent once the request exists. */
interface Paper {
  key: string;
  file: File;
  type: RequestAttachmentType;
}

/** The card's tenancy, read as the capacity the citizen most likely asks in. */
const CAPACITY_FROM_OCCUPANCY: Partial<Record<string, ApplicantCapacity>> = {
  OWNER: 'OWNER',
  TENANT: 'TENANT',
  FREE_OCCUPANT: 'FREE_OCCUPANT',
};

/**
 * «طلب جديد» — a citizen asks the municipality for a paper online (open
 * decisions §20 D8): what they need, for which of their properties and in what
 * capacity, with a copy of their identity card (D2), in four steps.
 *
 * The step is in the URL, so the phone's back button walks back through them;
 * what was chosen lives only in this page's memory and never in storage — an
 * identity photo does not belong in a browser's storage on a shared phone. A
 * reload starts again from the first step that is missing its answer.
 *
 * The request is filed first, then the papers sent one at a time (photos shrunk
 * first, `compressPaper`); the citizen lands on the request's own page, which
 * says where to pay the fee (the municipality's cash office while online payment
 * is paused, `lib/online-payment.ts`) and where a paper that failed can be added
 * again. The retry
 * key is held under `request:mine:<citizenId>`, so a lost answer and a second press file
 * the request once.
 */
export default function NewMyRequestPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const base = `/${tenant}/${locale}`;
  const t = useTranslations('citizenRequests.wizard');
  const labels = getLabels(locale);
  const router = useRouter();
  const { token, citizenId, endIfSignedOut } = useCitizenSession(tenant, base);
  /** One retry key per citizen (`lib/request-id.ts`): a shared phone changes hands. */
  const scope: KeyScope = `request:mine:${citizenId ?? ''}`;
  const [{ step: urlStep }] = useUrlState(URL_STATE);

  const [types, setTypes] = useState<RequestTypeSettingView[] | null>(null);
  const [properties, setProperties] = useState<CitizenProfileProperty[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [requestType, setRequestType] = useState<RequestType | ''>('');
  const [propertyEntryId, setPropertyEntryId] = useState('');
  const [buildingUnitId, setBuildingUnitId] = useState('');
  const [capacity, setCapacity] = useState<ApplicantCapacity | ''>('');
  const [purpose, setPurpose] = useState('');
  const [papers, setPapers] = useState<Paper[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [sending, setSending] = useState<'filing' | 'papers' | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const [offered, summary] = await Promise.all([
          getOfferedRequestTypes(tenant, token, signal),
          getMySummary(tenant, token),
        ]);
        if (signal?.aborted) return;
        setTypes(offered.filter((setting) => setting.enabled));
        // A card whose tenancy ended is history: nothing to certify on it.
        setProperties(summary.properties.filter((card) => !card.endedAt));
        setLoadError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        logApiError(caught);
        if (endIfSignedOut(caught)) return;
        setLoadError(t('loadError'));
      }
    },
    [tenant, token, endIfSignedOut, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const chosenType = types?.find((setting) => setting.requestType === requestType);
  const needsProperty = requestType ? requestNeedsProperty(requestType) : false;
  const property = properties?.find((card) => card.id === propertyEntryId);
  const units = (property?.units ?? []).filter((unit) => !unit.endedAt);
  const identity = papers.find((paper) => paper.type === 'IDENTITY');

  /** The first step whose answer is missing; `review` when every step has one. */
  const firstMissing = useMemo<Step>(() => {
    if (!requestType) return 'type';
    if ((needsProperty && !propertyEntryId) || !capacity) return 'property';
    if (!identity) return 'papers';
    return 'review';
  }, [requestType, needsProperty, propertyEntryId, capacity, identity]);

  /*
    A reload, or an address typed straight to a later step, has nothing chosen:
    the page shows the first unanswered step, whatever the address says, and
    then puts the address right. Shown from state rather than waiting on the
    address: a `replaceState` made while the page mounts can run before the
    router listens for it, and the screen stayed on the empty later step.
  */
  const step: Step = STEPS.indexOf(urlStep) > STEPS.indexOf(firstMissing) ? firstMissing : urlStep;
  useEffect(() => {
    if (step !== urlStep) window.history.replaceState(null, '', `${window.location.pathname}?step=${step}`);
  }, [step, urlStep]);

  const goTo = (next: Step) => {
    setStepError(null);
    window.history.pushState(null, '', `${window.location.pathname}?step=${next}`);
    window.scrollTo({ top: 0 });
  };

  const forward = () => {
    if (step === 'type' && !requestType) return setStepError(t('required.type'));
    if (step === 'property') {
      if (needsProperty && !propertyEntryId) return setStepError(t('required.property'));
      if (!capacity) return setStepError(t('required.capacity'));
    }
    if (step === 'papers' && !identity) return setStepError(t('required.identity'));
    goTo(STEPS[STEPS.indexOf(step) + 1]);
  };

  const pickProperty = (id: string) => {
    setPropertyEntryId(id);
    setBuildingUnitId('');
    const card = properties?.find((entry) => entry.id === id);
    const suggested = card ? CAPACITY_FROM_OCCUPANCY[card.occupancyType] : undefined;
    if (suggested && !capacity) setCapacity(suggested);
    setStepError(null);
  };

  const propertyLabel = (card: CitizenProfileProperty): string =>
    (labels.propertyType as Record<string, string>)[card.propertyType] ?? card.propertyType;

  // ── papers ────────────────────────────────────────────────────────────────────

  const addPapers = async (files: File[], type?: RequestAttachmentType) => {
    setPaperError(null);
    setPreparing(true);
    try {
      const accepted: Paper[] = [];
      for (const picked of files) {
        if (papers.length + accepted.length >= REQUEST_ATTACHMENTS_MAX) {
          setPaperError(t('papersFull', { max: REQUEST_ATTACHMENTS_MAX }));
          break;
        }
        // Shrunk first, then judged: a 6 MB phone photo is a 400 KB paper once shrunk.
        const file = await compressPaper(picked);
        const problem = attachmentProblem(file);
        if (problem) {
          setPaperError(t(`fileProblem.${problem}`, { name: picked.name, max: REQUEST_ATTACHMENT_MAX_MB }));
          continue;
        }
        accepted.push({ key: newRequestId(), file, type: type ?? 'OTHER' });
      }
      if (accepted.length) {
        setPapers((current) =>
          // One identity copy: a new one replaces the old.
          type === 'IDENTITY' ? [...current.filter((paper) => paper.type !== 'IDENTITY'), ...accepted] : [...current, ...accepted],
        );
        setStepError(null);
      }
    } finally {
      setPreparing(false);
    }
  };

  const removePaper = (key: string) => setPapers((current) => current.filter((paper) => paper.key !== key));

  // ── sending ───────────────────────────────────────────────────────────────────

  const send = async () => {
    if (inFlight.current || !token || !citizenId) return;
    setSendError(null);
    const parsed = submitOnlineRequestSchema.safeParse({
      requestType: requestType || undefined,
      applicantCapacity: capacity || undefined,
      propertyEntryId: propertyEntryId || undefined,
      buildingUnitId: buildingUnitId || undefined,
      purpose,
      clientRequestId: heldKey(tenant, scope),
    });
    if (!parsed.success) {
      goTo(firstMissing === 'review' ? 'property' : firstMissing);
      return;
    }

    inFlight.current = true;
    setSending('filing');
    let id: string;
    try {
      id = (await submitMyRequest(tenant, token, parsed.data)).id;
    } catch (caught) {
      logApiError(caught);
      if (endIfSignedOut(caught)) return;
      if (keyIsSpent(caught)) spendKey(tenant, scope);
      else if (outcomeInDoubt(caught)) markInDoubt(tenant, scope);
      setSendError(caught instanceof Error && caught.message ? caught.message : t('sendFailed'));
      inFlight.current = false;
      setSending(null);
      return;
    }
    spendKey(tenant, scope);

    // The identity copy first: it is what the fee waits for (D2).
    setSending('papers');
    const ordered = [...papers].sort((a, b) => Number(b.type === 'IDENTITY') - Number(a.type === 'IDENTITY'));
    let failed = 0;
    for (const paper of ordered) {
      try {
        await uploadMyRequestAttachment(tenant, token, { id, type: paper.type, file: paper.file, fileName: paper.file.name });
      } catch (caught) {
        logApiError(caught);
        failed += 1;
      }
    }
    router.replace(`${base}/my-file/requests/${id}?filed=1${failed ? `&failed=${failed}` : ''}`);
  };

  if (!token) return null;

  const busy = sending !== null;
  const retrying = heldInDoubt(tenant, scope);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('lead')}</p>
      </div>

      <ol className="grid grid-cols-4 gap-2" aria-label={t('stepsLabel')}>
        {STEPS.map((name, index) => {
          const current = name === step;
          const done = STEPS.indexOf(step) > index;
          return (
            <li key={name} aria-current={current ? 'step' : undefined} className="space-y-1.5">
              <span
                aria-hidden
                className={cn('block h-1 rounded-full', current || done ? 'bg-primary' : 'bg-muted')}
              />
              <span className={cn('block text-xs', current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                {t('stepCount', { index: index + 1, total: STEPS.length })}
                <span className="hidden sm:inline"> · {t(`steps.${name}`)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <Card>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <h2 className="text-lg font-semibold">{t(`steps.${step}`)}</h2>

          {loadError ? (
            <div className="space-y-3">
              <Alert variant="destructive" live="alert">
                {loadError}
              </Alert>
              <Button type="button" variant="outline" onClick={() => void load()}>
                {t('retry')}
              </Button>
            </div>
          ) : !types || !properties ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : types.length === 0 ? (
            <Alert variant="info">{t('noTypes')}</Alert>
          ) : step === 'type' ? (
            <div role="radiogroup" aria-label={t('steps.type')} className="grid gap-2 sm:grid-cols-2">
              {types.map((setting) => (
                <ChoiceCard
                  key={setting.requestType}
                  name="request-type"
                  value={setting.requestType}
                  checked={requestType === setting.requestType}
                  onChange={(value) => {
                    setRequestType(value as RequestType);
                    setStepError(null);
                  }}
                  title={labels.requestType[setting.requestType]}
                  description={
                    setting.feeAmount > 0 ? <Money amount={setting.feeAmount} locale={locale} exact /> : t('free')
                  }
                  className="min-h-touch"
                />
              ))}
            </div>
          ) : step === 'property' ? (
            <div className="space-y-5">
              {needsProperty && properties.length === 0 ? (
                <Alert variant="warning">{t('noCardsNeeded')}</Alert>
              ) : (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    {needsProperty ? t('propertyNeeded') : t('propertyOptional')}
                  </legend>
                  <div role="radiogroup" className="grid gap-2">
                    {!needsProperty ? (
                      <ChoiceCard
                        name="request-property"
                        value=""
                        checked={propertyEntryId === ''}
                        onChange={() => pickProperty('')}
                        title={t('noProperty')}
                        className="min-h-touch"
                      />
                    ) : null}
                    {properties.map((card) => (
                      <ChoiceCard
                        key={card.id}
                        name="request-property"
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
                          </>
                        }
                        className="min-h-touch"
                      />
                    ))}
                  </div>
                </fieldset>
              )}

              {property && units.length > 0 ? (
                <Field htmlFor="request-unit" label={t('unit')} optionalLabel={t('optional')}>
                  {/* Keyed on the card, so a unit cleared above is cleared in Radix too (docs/gotchas.md). */}
                  <Select
                    key={property.id}
                    value={buildingUnitId || 'WHOLE'}
                    onValueChange={(value) => setBuildingUnitId(value === 'WHOLE' ? '' : value)}
                  >
                    <SelectTrigger id="request-unit">
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

              <Field htmlFor="request-capacity" label={t('capacity')} required>
                <Select
                  value={capacity}
                  onValueChange={(value) => {
                    setCapacity(value as ApplicantCapacity);
                    setStepError(null);
                  }}
                >
                  <SelectTrigger id="request-capacity">
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

              <Field htmlFor="request-purpose" label={t('purpose')} optionalLabel={t('optional')}>
                <Textarea
                  id="request-purpose"
                  rows={2}
                  maxLength={500}
                  value={purpose}
                  placeholder={t('purposePlaceholder')}
                  onChange={(event) => setPurpose(event.target.value)}
                />
              </Field>
            </div>
          ) : step === 'papers' ? (
            <div className="space-y-5">
              <section className="space-y-2" aria-labelledby="identity-heading">
                <h3 id="identity-heading" className="text-sm font-medium">
                  {t('identityTitle')} <span className="text-destructive">*</span>
                </h3>
                <p className="text-sm text-muted-foreground">{t('identityHint')}</p>
                {identity ? (
                  <PaperRow
                    paper={identity}
                    removeLabel={t('remove', { name: identity.file.name })}
                    sizeLabel={t('size', { kb: kilobytes(identity.file) })}
                    onRemove={removePaper}
                  />
                ) : (
                  <FileInput
                    id="request-identity"
                    accept={REQUEST_ATTACHMENT_ACCEPT}
                    disabled={preparing}
                    onSelect={(files) => void addPapers(files.slice(0, 1), 'IDENTITY')}
                    label={preparing ? t('preparing') : t('pickIdentity')}
                    hint={t('fileHint', { max: REQUEST_ATTACHMENT_MAX_MB })}
                  />
                )}
              </section>

              <section className="space-y-2" aria-labelledby="other-heading">
                <h3 id="other-heading" className="text-sm font-medium">
                  {t('otherTitle')} <span className="text-xs font-normal text-muted-foreground">{t('optional')}</span>
                </h3>
                <p className="text-sm text-muted-foreground">{t('otherHint')}</p>
                {papers.filter((paper) => paper.type !== 'IDENTITY').length > 0 ? (
                  <ul className="space-y-2">
                    {papers
                      .filter((paper) => paper.type !== 'IDENTITY')
                      .map((paper) => (
                        <li key={paper.key} className="space-y-2 rounded-lg border p-3">
                          <PaperRow
                            paper={paper}
                            removeLabel={t('remove', { name: paper.file.name })}
                            sizeLabel={t('size', { kb: kilobytes(paper.file) })}
                            onRemove={removePaper}
                            bare
                          />
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
                            <SelectTrigger aria-label={t('paperType', { name: paper.file.name })}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {REQUEST_ATTACHMENT_TYPE.filter((value) => value !== 'IDENTITY').map((value) => (
                                <SelectItem key={value} value={value}>
                                  {labels.requestAttachmentType[value]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </li>
                      ))}
                  </ul>
                ) : null}
                {papers.length < REQUEST_ATTACHMENTS_MAX ? (
                  <FileInput
                    id="request-other"
                    accept={REQUEST_ATTACHMENT_ACCEPT}
                    multiple
                    disabled={preparing}
                    onSelect={(files) => void addPapers(files)}
                    label={preparing ? t('preparing') : t('pickOther')}
                    hint={t('fileHint', { max: REQUEST_ATTACHMENT_MAX_MB })}
                  />
                ) : null}
              </section>

              {paperError ? (
                <Alert variant="destructive" live="alert">
                  {paperError}
                </Alert>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <SummaryList>
                <SummaryRow label={t('summary.type')}>{requestType ? labels.requestType[requestType] : '—'}</SummaryRow>
                <SummaryRow label={t('summary.property')}>
                  {property ? (
                    <>
                      {propertyLabel(property)}
                      {property.propertyNumber ? (
                        <>
                          {' '}
                          <bdi dir="ltr" className="font-mono">
                            {property.propertyNumber}
                          </bdi>
                        </>
                      ) : null}
                    </>
                  ) : (
                    t('noProperty')
                  )}
                </SummaryRow>
                <SummaryRow label={t('summary.capacity')}>{capacity ? labels.applicantCapacity[capacity] : '—'}</SummaryRow>
                <SummaryRow label={t('summary.papers')}>{papers.length}</SummaryRow>
                <SummaryRow label={t('summary.fee')}>
                  {chosenType && chosenType.feeAmount > 0 ? (
                    <Money amount={chosenType.feeAmount} locale={locale} exact />
                  ) : (
                    t('free')
                  )}
                </SummaryRow>
              </SummaryList>
              <p className="text-sm text-muted-foreground">
                {chosenType && chosenType.feeAmount > 0 ? t('afterPaid', onlineCopy()) : t('afterFree')}
              </p>
              {retrying ? <Alert variant="warning">{t('retrying')}</Alert> : null}
              {sendError ? (
                <Alert variant="destructive" live="alert">
                  {sendError}
                </Alert>
              ) : null}
            </div>
          )}

          {stepError ? (
            <p role="alert" className="text-sm text-destructive">
              {stepError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {types && types.length > 0 && properties ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {step === 'type' ? (
            <Button type="button" variant="outline" onClick={() => router.push(`${base}/my-file`)} disabled={busy}>
              {t('cancel')}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => window.history.back()} disabled={busy}>
              {locale === 'en' ? <ArrowLeft className="size-4" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
              {t('back')}
            </Button>
          )}
          {step === 'review' ? (
            <Button type="button" onClick={() => void send()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {sending === 'filing' ? t('sending') : sending === 'papers' ? t('sendingPapers') : t('send')}
            </Button>
          ) : (
            <Button type="button" onClick={forward} disabled={preparing}>
              {t('next')}
              {locale === 'en' ? <ArrowRight className="size-4" aria-hidden /> : <ArrowLeft className="size-4" aria-hidden />}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A file's size in whole kilobytes, at least one. */
function kilobytes(file: File): number {
  return Math.max(1, Math.round(file.size / 1024));
}

/** A picked paper: its name and size, and the control that takes it out again. */
function PaperRow({
  paper,
  removeLabel,
  sizeLabel,
  onRemove,
  bare = false,
}: {
  paper: Paper;
  removeLabel: string;
  sizeLabel: string;
  onRemove: (key: string) => void;
  /** Inside a bordered row already. */
  bare?: boolean;
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-3', !bare && 'rounded-lg border p-3')}>
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <bdi className="block truncate text-sm font-medium">{paper.file.name}</bdi>
        <span className="block text-xs text-muted-foreground">{sizeLabel}</span>
      </span>
      <Button type="button" variant="ghost" size="icon" aria-label={removeLabel} onClick={() => onRemove(paper.key)}>
        <X className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
