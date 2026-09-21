'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, ClipboardCheck, FileQuestion, Loader2, RotateCcw, Undo2 } from 'lucide-react';
import { getLabels, qualityLabels, REVIEW_FIELD, type ReviewField } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import {
  approveRecord,
  getReviewQueue,
  returnRecord,
  type ReviewQueueItem,
  type ReviewTab,
} from '@/lib/quality-api';
import { flagFieldLabel } from '@/lib/field-flags';
import { formatDateTime, formatRelative } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const ANY = 'ANY';

const STATE_BADGE: Record<ReviewQueueItem['state'], { variant: 'soft-warning' | 'soft-info' | 'soft-success' | 'soft-muted'; ar: string; en: string }> = {
  NEW: { variant: 'soft-info', ar: 'جديد', en: 'New' },
  CORRECTED: { variant: 'soft-warning', ar: 'صُحِّح — بانتظار المراجعة', en: 'Corrected — needs review' },
  CHANGED: { variant: 'soft-warning', ar: 'عُدِّل بعد الاعتماد', en: 'Edited since approval' },
  RETURNED: { variant: 'soft-warning', ar: 'عند الموظف للتصحيح', en: 'With the officer' },
  APPROVED: { variant: 'soft-success', ar: 'معتمد', en: 'Approved' },
};

/**
 * «مراجعة السجلات» — a second pair of eyes on what the field filed.
 *
 * One card per record, carrying what a reviewer decides on: who filed it, what
 * they left «غير مؤكَّد», what property it claims, and the record's own review
 * history. The two answers sit at the foot of the card; «إعادة للموظف» opens
 * its reason inline rather than in a dialog, because the reason is the decision
 * and a modal would hide the record it is about.
 */
export function ReviewQueue({
  tenant,
  base,
  locale,
  token,
  officers,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  officers: Array<{ id: string; name: string }>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const quality = qualityLabels(locale);
  const toast = useToast();

  const [tab, setTab] = useState<ReviewTab>('TO_REVIEW');
  const [officerId, setOfficerId] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [returning, setReturning] = useState<string | null>(null);

  const query = useStaffQuery({
    queryKey: ['quality-reviews', tenant, tab, officerId, flaggedOnly],
    queryFn: (tok, signal) =>
      getReviewQueue(tenant, tok, { tab, officerId: officerId || undefined, flaggedOnly, limit: 30 }, signal),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the review queue.' : 'تعذّر تحميل قائمة المراجعة.',
    keepPrevious: true,
  });

  const counts = query.data?.counts;
  const tabs: Array<{ key: ReviewTab; label: string; count: number | undefined }> = [
    {
      key: 'TO_REVIEW',
      label: en ? 'To review' : 'للمراجعة',
      count: counts ? counts.NEW + counts.CORRECTED + counts.CHANGED : undefined,
    },
    { key: 'RETURNED', label: en ? 'With officers' : 'عند الموظفين', count: counts?.RETURNED },
    { key: 'APPROVED', label: en ? 'Approved' : 'معتمدة', count: counts?.APPROVED },
  ];

  const act = async (registrationId: string, run: () => Promise<unknown>, done: string) => {
    if (!token) return;
    setBusy(registrationId);
    try {
      await run();
      toast.success(done);
      setReturning(null);
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      toast.error(
        caught instanceof ApiRequestError
          ? caught.message
          : en
            ? 'The decision was not saved.'
            : 'لم يُحفظ القرار.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label={en ? 'Review state' : 'حالة المراجعة'} className="flex rounded-lg border p-0.5">
          {tabs.map((option) => (
            <button
              key={option.key}
              role="tab"
              aria-selected={tab === option.key}
              onClick={() => setTab(option.key)}
              className={cn(
                'flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
                tab === option.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {option.label}
              {option.count !== undefined ? (
                <span className={cn('tabular-nums', tab === option.key ? 'opacity-90' : 'text-muted-foreground')}>
                  {option.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="min-w-[12rem] space-y-1">
          <Label htmlFor="review-officer" className="text-xs text-muted-foreground">
            {en ? 'Filed by' : 'الموظف الذي سجَّل'}
          </Label>
          <Select value={officerId || ANY} onValueChange={(value) => setOfficerId(value === ANY ? '' : value)}>
            <SelectTrigger id="review-officer" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{en ? 'Everyone' : 'الجميع'}</SelectItem>
              {officers.map((officer) => (
                <SelectItem key={officer.id} value={officer.id}>
                  {officer.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant={flaggedOnly ? 'default' : 'outline'}
          size="sm"
          className="h-9 gap-1.5"
          aria-pressed={flaggedOnly}
          onClick={() => setFlaggedOnly((current) => !current)}
        >
          <FileQuestion className="size-4" aria-hidden />
          {en ? 'Unverified fields only' : 'ما فيه حقول غير مؤكَّدة'}
        </Button>
      </div>

      {query.error ? (
        <ErrorState description={query.error} onRetry={query.refetch} />
      ) : query.loading ? (
        <LoadingState label={en ? 'Loading records…' : 'جارٍ تحميل السجلات…'} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={
            tab === 'TO_REVIEW'
              ? en
                ? 'Nothing waiting for review'
                : 'لا سجلات تنتظر المراجعة'
              : tab === 'RETURNED'
                ? en
                  ? 'No record is with an officer'
                  : 'لا سجلات عند الموظفين'
                : en
                  ? 'No approved records yet'
                  : 'لا سجلات معتمدة بعد'
          }
          description={
            tab === 'TO_REVIEW'
              ? en
                ? 'Every filed record has been looked at.'
                : 'كل سجل مُقدَّم جرت مراجعته.'
              : undefined
          }
        />
      ) : (
        <ol className="space-y-3">
          {query.data!.items.map((item) => {
            const badge = STATE_BADGE[item.state];
            const openReturn = item.history.find((entry) => entry.outcome === 'RETURNED' && !entry.resolvedAt);
            return (
              /*
                Bands, not one run of stacked blocks.

                A record card carries four different kinds of thing — who and
                when, the property claimed, the fields left unconfirmed, the
                review history — and run together with `space-y` they read as
                one wall of small text a reviewer has to parse before they can
                decide anything. A coloured rule between them says where each
                answer stops — heavier than the grey hairline between one fact
                and the next inside a band, so the two cannot be confused — and
                every band lays its facts as rows, values on the far edge.
              */
              <li key={item.registrationId} className="overflow-hidden rounded-xl border bg-card">
                <div className="divide-y-2 divide-primary/30 [&>*]:px-4 [&>*]:py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Link
                      href={`${base}/citizens/${encodeURIComponent(item.citizen.id)}`}
                      className="text-base font-semibold text-primary underline-offset-4 hover:underline"
                    >
                      {item.citizen.name}
                    </Link>
                    {item.citizen.referenceNumber ? (
                      <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                        {item.citizen.referenceNumber}
                      </span>
                    ) : null}
                    <Badge variant={badge.variant}>{en ? badge.en : badge.ar}</Badge>
                    <span className="ms-auto text-xs text-muted-foreground" title={formatDateTime(item.submittedAt)}>
                      {formatRelative(item.submittedAt, locale)}
                    </span>
                  </div>

                  {/*
                    The record itself, on the card's column rhythm.

                    This was a run-on line — «سجَّله فلان  والدته فلانة  ٤ أفراد
                    مقيم» — readable once and unscannable down a queue of
                    twenty. The fields a decision actually turns on (who filed
                    it, when it last moved, how many doors it claims) are
                    stated rather than left for whoever thinks to open the file.
                  */}
                  <FactRow>
                    <FactCell
                      label={en ? 'Filed by' : 'سجَّله'}
                      value={item.officer?.name ?? (en ? 'unknown' : 'غير معروف')}
                    />
                    <FactCell label={en ? 'Filed on' : 'تاريخ التقديم'} value={formatDateTime(item.submittedAt)} />
                    {item.updatedAt !== item.submittedAt ? (
                      <FactCell label={en ? 'Last edited' : 'آخر تعديل'} value={formatDateTime(item.updatedAt)} />
                    ) : null}
                    <FactCell
                      label={en ? 'Record ref.' : 'مرجع السجل'}
                      className="font-mono"
                      value={item.referenceNumber}
                    />
                    {item.citizen.motherName ? (
                      <FactCell label={en ? 'Mother' : 'اسم الأم'} value={item.citizen.motherName} />
                    ) : null}
                    {item.citizen.householdMembers != null ? (
                      <FactCell
                        label={en ? 'Household' : 'أفراد الأسرة'}
                        value={
                          en
                            ? `${item.citizen.householdMembers}`
                            : `${item.citizen.householdMembers} أفراد`
                        }
                      />
                    ) : null}
                    <FactCell
                      label={en ? 'Residence' : 'مكان الإقامة'}
                      value={labels.citizenResidence[item.citizen.residence as never] ?? item.citizen.residence}
                    />
                    <FactCell
                      label={en ? 'Properties' : 'العقارات'}
                      value={
                        item.properties.length === 0
                          ? en
                            ? 'none on this record'
                            : 'لا عقار على هذا السجل'
                          : en
                            ? `${item.properties.length}`
                            : `${item.properties.length}`
                      }
                    />
                  </FactRow>

                  {/*
                    Each property spelled out rather than squeezed into a pill.
                    A «شقة · مالك · عقار 498 · X-498-A · 3 وحدة» chip hides which
                    dot is which the moment one of the parts is missing.
                  */}
                  {item.properties.map((card, index) => (
                    <div key={`${item.registrationId}-${index}`} className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {item.properties.length > 1
                          ? `${en ? 'Property' : 'العقار'} ${index + 1}`
                          : en
                            ? 'Property'
                            : 'العقار'}
                      </p>
                      <FactRow>
                        <FactCell
                          label={en ? 'Type' : 'النوع'}
                          value={labels.propertyType[card.propertyType as never] ?? card.propertyType}
                        />
                        {card.occupancyType ? (
                          <FactCell
                            label={en ? 'Occupancy' : 'صفة الإشغال'}
                            value={labels.occupancyType[card.occupancyType as never] ?? card.occupancyType}
                          />
                        ) : null}
                        {card.propertyNumber ? (
                          <FactCell label={en ? 'Parcel' : 'رقم العقار'} value={card.propertyNumber} />
                        ) : null}
                        {card.buildingCode || card.buildingName ? (
                          <FactCell
                            label={en ? 'Building' : 'المبنى'}
                            value={[card.buildingCode, card.buildingName].filter(Boolean).join(' — ')}
                          />
                        ) : null}
                        {card.unitCount > 0 ? (
                          <FactCell
                            label={en ? 'Units' : 'عدد الوحدات'}
                            value={en ? `${card.unitCount}` : `${card.unitCount} وحدة`}
                          />
                        ) : null}
                        {card.unitArea != null ? (
                          <FactCell
                            label={en ? 'Area' : 'المساحة'}
                            value={`${card.unitArea} ${en ? 'm²' : 'م²'}`}
                          />
                        ) : null}
                      </FactRow>
                    </div>
                  ))}

                  {item.flags.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-warning">
                        {en ? 'Fields left unconfirmed' : 'حقول غير مؤكَّدة'}
                      </p>
                      <FactRow>
                        {item.flags.map((flag) => (
                          <FactCell
                            key={flag.path}
                            label={
                              <span className="text-warning">{flagFieldLabel(flag.path, locale)}</span>
                            }
                            className="max-w-sm text-muted-foreground"
                            value={flag.reason}
                          />
                        ))}
                      </FactRow>
                    </div>
                  ) : null}

                  {/* Already its own band — no inner box needed on top of it. */}
                  {item.notes ? (
                    <div className="space-y-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {en ? 'Officer’s note' : 'ملاحظة الموظف'}
                      </p>
                      <p className="text-xs leading-relaxed">{item.notes}</p>
                    </div>
                  ) : null}

                  {item.history.length > 0 ? (
                    <details className="text-xs">
                      <summary className="w-fit cursor-pointer text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                        {en ? `Review history (${item.history.length})` : `سجل المراجعات (${item.history.length})`}
                      </summary>
                      {/* Divided, not boxed — a rule separates these entries
                          without drawing a frame round every value in them. */}
                      <ol className="mt-2 divide-y">
                        {item.history.map((entry) => (
                          <li key={entry.id} className="py-1.5 first:pt-0 last:pb-0">
                            <span className="font-medium">
                              {entry.outcome === 'APPROVED'
                                ? en
                                  ? 'Approved'
                                  : 'اعتماد'
                                : en
                                  ? 'Returned'
                                  : 'إعادة للموظف'}
                            </span>{' '}
                            <span className="text-muted-foreground">
                              — {entry.by ?? (en ? 'unknown' : 'غير معروف')} · {formatDateTime(entry.at)}
                            </span>
                            {entry.reason ? <p className="mt-0.5 text-muted-foreground">{entry.reason}</p> : null}
                            {entry.fields.length > 0 ? (
                              <p className="mt-0.5 text-muted-foreground">
                                {entry.fields.map((field) => quality.reviewField[field] ?? field).join('، ')}
                              </p>
                            ) : null}
                            {entry.resolvedAt ? (
                              <p className="mt-0.5 text-emerald-700 dark:text-emerald-400">
                                {en ? 'Corrected' : 'صُحِّح'} — {entry.resolvedBy ?? ''} · {formatDateTime(entry.resolvedAt)}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}

                  {openReturn ? (
                    <div className="space-y-1 bg-warning/5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-warning">
                        {en ? 'Waiting on the officer' : 'بانتظار الموظف'}
                      </p>
                      <p className="text-xs leading-relaxed text-warning">{openReturn.reason}</p>
                    </div>
                  ) : null}
                </div>

                {returning === item.registrationId ? (
                  <ReturnForm
                    locale={locale}
                    busy={busy === item.registrationId}
                    onCancel={() => setReturning(null)}
                    onSubmit={(input) =>
                      act(
                        item.registrationId,
                        () => returnRecord(tenant, token!, item.registrationId, input),
                        en ? 'Returned to the officer' : 'أُعيد السجل إلى الموظف',
                      )
                    }
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/20 px-4 py-3">
                    {item.state !== 'RETURNED' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={busy === item.registrationId}
                        onClick={() => setReturning(item.registrationId)}
                      >
                        <Undo2 className="size-4" aria-hidden />
                        {en ? 'Return to the officer' : 'إعادة إلى الموظف'}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={busy === item.registrationId}
                      onClick={() =>
                        act(
                          item.registrationId,
                          () => approveRecord(tenant, token!, item.registrationId),
                          en ? 'Record approved' : 'تم اعتماد السجل',
                        )
                      }
                    >
                      {busy === item.registrationId ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <Check className="size-4" aria-hidden />
                      )}
                      {item.state === 'APPROVED' ? (en ? 'Approve again' : 'إعادة الاعتماد') : en ? 'Approve' : 'اعتماد'}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** «إعادة إلى الموظف» — what is wrong, and the sentence they will read. */
function ReturnForm({
  locale,
  busy,
  onCancel,
  onSubmit,
}: {
  locale: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { reason: string; fields: ReviewField[] }) => void;
}) {
  const en = locale === 'en';
  const quality = qualityLabels(locale);
  const [fields, setFields] = useState<ReviewField[]>([]);
  const [reason, setReason] = useState('');
  const ready = fields.length > 0 && reason.trim().length >= 4;

  return (
    <div className="space-y-3 border-t bg-warning/5 px-4 py-3">
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium">{en ? 'What needs correcting?' : 'ما الذي يحتاج تصحيحاً؟'}</legend>
        <div className="flex flex-wrap gap-1.5">
          {REVIEW_FIELD.map((field) => {
            const on = fields.includes(field);
            return (
              <button
                key={field}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setFields((current) => (on ? current.filter((value) => value !== field) : [...current, field]))
                }
                className={cn(
                  'min-h-8 rounded-md border px-2.5 text-xs transition-colors',
                  on ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                )}
              >
                {quality.reviewField[field]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor="return-reason" className="text-xs">
          {en ? 'What should the officer do?' : 'ماذا على الموظف أن يفعل؟'}
        </Label>
        <Textarea
          id="return-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          className="min-h-[72px] text-sm"
          placeholder={
            en
              ? 'e.g. the phone is the landlord’s — visit and record the occupant’s own number'
              : 'مثال: الرقم المسجَّل هو رقم صاحب الملك — زُر الوحدة وسجِّل رقم الشاغل'
          }
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {en ? 'Cancel' : 'إلغاء'}
        </Button>
        <Button size="sm" className="gap-1.5" disabled={!ready || busy} onClick={() => onSubmit({ reason: reason.trim(), fields })}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
          {en ? 'Send back' : 'إعادة السجل'}
        </Button>
      </div>
    </div>
  );
}
