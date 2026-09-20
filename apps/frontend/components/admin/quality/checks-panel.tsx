'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Loader2, Shuffle } from 'lucide-react';
import { CHECK_DIFFERENCE, getLabels, qualityLabels, type CheckDifference } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import {
  assignQualityCheck,
  completeQualityCheck,
  drawQualitySample,
  getQualityChecks,
  type QualityCheck,
} from '@/lib/quality-api';
import { formatDate, formatDateTime } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Badge } from '@/components/ui/badge';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const UNASSIGNED = 'UNASSIGNED';

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * «عيّنة التحقق» — a share of each officer's records, re-checked on the ground
 * by somebody else.
 *
 * The share is per officer on purpose: 5% of the municipality would be mostly
 * the busiest officer's work and would say nothing about anyone else's. What
 * comes back is not a correction — a wrong record is fixed the ordinary way —
 * it is the one number that says how often what was filed matches what is
 * there.
 */
export function ChecksPanel({
  tenant,
  base,
  locale,
  token,
  canReview,
  officers,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  /** Supervisors draw and assign; an officer only answers what is theirs to do. */
  canReview: boolean;
  officers: Array<{ id: string; name: string }>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const quality = qualityLabels(locale);
  const toast = useToast();

  const [status, setStatus] = useState<'OPEN' | 'DONE'>('OPEN');
  const [from, setFrom] = useState(isoDaysAgo(7));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [percent, setPercent] = useState('5');
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);

  const query = useStaffQuery({
    queryKey: ['quality-checks', tenant, status],
    queryFn: (tok, signal) => getQualityChecks(tenant, tok, { status }, signal),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the checks.' : 'تعذّر تحميل عمليات التحقق.',
    keepPrevious: true,
  });

  const draw = async () => {
    if (!token) return;
    setDrawing(true);
    try {
      const result = await drawQualitySample(tenant, token, { from, to, percent: Number(percent) || 5 });
      toast.success(
        result.sampled > 0
          ? en
            ? `${result.sampled} record(s) added to the sample`
            : `أُضيف ${result.sampled} سجلاً إلى العيّنة`
          : en
            ? 'The sample already covers this period'
            : 'العيّنة تغطي هذه الفترة بالفعل',
      );
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : en ? 'Could not draw a sample.' : 'تعذّر سحب العيّنة.');
    } finally {
      setDrawing(false);
    }
  };

  const run = async (id: string, work: () => Promise<unknown>, done: string) => {
    if (!token) return;
    setBusy(id);
    try {
      await work();
      toast.success(done);
      setAnswering(null);
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : en ? 'Not saved.' : 'لم يُحفظ.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {canReview ? (
        <section className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="sample-from" className="text-xs text-muted-foreground">
              {en ? 'Records filed from' : 'سجلات مقدَّمة من'}
            </Label>
            <DatePicker id="sample-from" value={from} onChange={setFrom} max={to} locale={en ? 'en' : 'ar'} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sample-to" className="text-xs text-muted-foreground">
              {en ? 'to' : 'إلى'}
            </Label>
            <DatePicker id="sample-to" value={to} onChange={setTo} max={isoDaysAgo(0)} locale={en ? 'en' : 'ar'} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sample-percent" className="text-xs text-muted-foreground">
              {en ? 'Share of each officer’s records (%)' : 'نسبة من سجلات كل موظف (٪)'}
            </Label>
            <Input
              id="sample-percent"
              inputMode="numeric"
              dir="ltr"
              className="h-10 text-start"
              value={percent}
              onChange={(event) => setPercent(event.target.value.replace(/\D/g, '').slice(0, 2))}
            />
          </div>
          <Button className="h-10 gap-1.5" onClick={draw} disabled={drawing || !from || !to}>
            {drawing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Shuffle className="size-4" aria-hidden />}
            {en ? 'Draw a sample' : 'سحب عيّنة'}
          </Button>
        </section>
      ) : null}

      <div className="flex gap-1.5">
        {(['OPEN', 'DONE'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
            className={cn(
              'min-h-9 rounded-md border px-3 text-sm transition-colors',
              status === value ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
            )}
          >
            {value === 'OPEN' ? (en ? 'To check' : 'بانتظار التحقق') : en ? 'Checked' : 'تم التحقق'}
          </button>
        ))}
      </div>

      {query.error ? (
        <ErrorState description={query.error} onRetry={query.refetch} />
      ) : query.loading ? (
        <LoadingState label={en ? 'Loading…' : 'جارٍ التحميل…'} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={status === 'OPEN' ? (en ? 'No open checks' : 'لا عمليات تحقق مفتوحة') : en ? 'No completed checks yet' : 'لا عمليات تحقق منجزة'}
          description={
            canReview && status === 'OPEN'
              ? en
                ? 'Draw a sample from a period above.'
                : 'اسحب عيّنة من فترة أعلاه.'
              : undefined
          }
        />
      ) : (
        <ol className="space-y-3">
          {query.data!.items.map((check) => (
            <li key={check.id} className="rounded-xl border bg-card p-4">
              <CheckHeader check={check} base={base} locale={locale} />

              {/* Aligned pairs, not chips — the same treatment «السجلات» uses,
                  so a property reads identically on both tabs. */}
              <div className="mt-2 space-y-2">
                {check.properties.map((card, index) => (
                  <FactRow key={`${check.id}-${index}`} className="text-xs">
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
                    {card.units.length > 0 ? (
                      <FactCell label={en ? 'Units' : 'الوحدات'} value={card.units.join('، ')} />
                    ) : null}
                  </FactRow>
                ))}
              </div>

              {check.status === 'DONE' ? (
                <div className="mt-3 space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                  <p>
                    <span className="font-medium">
                      {check.result === 'MATCHES'
                        ? en
                          ? 'Matches the record'
                          : 'مطابق للسجل'
                        : en
                          ? 'Differs from the record'
                          : 'مختلف عن السجل'}
                    </span>
                    <span className="text-muted-foreground">
                      {' '}
                      — {check.checkedBy ?? ''} · {check.checkedAt ? formatDateTime(check.checkedAt) : ''}
                    </span>
                  </p>
                  {check.differences.length > 0 ? (
                    <p className="text-muted-foreground">
                      {check.differences.map((code) => quality.checkDifference[code] ?? code).join('، ')}
                    </p>
                  ) : null}
                  {check.notes ? <p className="text-foreground/90">{check.notes}</p> : null}
                </div>
              ) : answering === check.id ? (
                <AnswerForm
                  locale={locale}
                  busy={busy === check.id}
                  onCancel={() => setAnswering(null)}
                  onSubmit={(input) =>
                    run(
                      check.id,
                      () => completeQualityCheck(tenant, token!, check.id, input),
                      en ? 'Check recorded' : 'سُجِّل التحقق',
                    )
                  }
                />
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {canReview ? (
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`assign-${check.id}`} className="text-xs text-muted-foreground">
                        {en ? 'Assigned to' : 'مُسنَد إلى'}
                      </Label>
                      <Select
                        value={check.assignedTo?.id ?? UNASSIGNED}
                        onValueChange={(value) =>
                          run(
                            check.id,
                            () => assignQualityCheck(tenant, token!, check.id, value === UNASSIGNED ? null : value),
                            en ? 'Assignment saved' : 'حُفظ الإسناد',
                          )
                        }
                      >
                        <SelectTrigger id={`assign-${check.id}`} className="h-9 w-[12rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNASSIGNED}>{en ? 'Anyone but the filer' : 'أي موظف غير صاحب السجل'}</SelectItem>
                          {officers
                            .filter((officer) => officer.id !== check.originalOfficer?.id)
                            .map((officer) => (
                              <SelectItem key={officer.id} value={officer.id}>
                                {officer.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <Button size="sm" className="ms-auto" onClick={() => setAnswering(check.id)} disabled={busy === check.id}>
                    {en ? 'Record what you found' : 'تسجيل ما وجدته'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CheckHeader({ check, base, locale }: { check: QualityCheck; base: string; locale: string }) {
  const en = locale === 'en';
  const quality = qualityLabels(locale);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <Link
        href={`${base}/citizens/${encodeURIComponent(check.citizen.id)}`}
        className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        {check.citizen.name}
      </Link>
      <span dir="ltr" className="font-mono text-xs text-muted-foreground">
        {check.referenceNumber}
      </span>
      {check.status === 'DONE' ? (
        <Badge variant={check.result === 'MATCHES' ? 'soft-success' : 'soft-destructive'}>
          {quality.checkResult[check.result ?? 'MATCHES']}
        </Badge>
      ) : check.assignedTo ? (
        <Badge variant="soft-info">{en ? `For ${check.assignedTo.name}` : `لـ ${check.assignedTo.name}`}</Badge>
      ) : (
        <Badge variant="soft-muted">{en ? 'Unassigned' : 'غير مُسنَد'}</Badge>
      )}
      <span className="ms-auto text-xs text-muted-foreground">
        {en ? 'Filed by' : 'سجَّله'} {check.originalOfficer?.name ?? '—'} · {formatDate(check.filedAt)}
      </span>
    </div>
  );
}

/** What the checker found on the ground. «مختلف» has to say what and write it down. */
export function AnswerForm({
  locale,
  busy,
  onCancel,
  onSubmit,
}: {
  locale: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { result: 'MATCHES' | 'DIFFERS'; differences: CheckDifference[]; notes?: string }) => void;
}) {
  const en = locale === 'en';
  const quality = qualityLabels(locale);
  const [result, setResult] = useState<'MATCHES' | 'DIFFERS' | null>(null);
  const [differences, setDifferences] = useState<CheckDifference[]>([]);
  const [notes, setNotes] = useState('');
  const ready = result === 'MATCHES' || (result === 'DIFFERS' && differences.length > 0 && notes.trim().length > 0);

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div role="radiogroup" className="grid gap-1.5 sm:grid-cols-2">
        {(['MATCHES', 'DIFFERS'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={result === value}
            onClick={() => setResult(value)}
            className={cn(
              'min-h-11 rounded-md border px-3 text-start text-sm transition-colors',
              result === value ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
            )}
          >
            {value === 'MATCHES'
              ? en
                ? 'What I found matches the record'
                : 'ما وجدته مطابق للسجل'
              : en
                ? 'Something is different'
                : 'هناك ما يختلف'}
          </button>
        ))}
      </div>

      {result === 'DIFFERS' ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {CHECK_DIFFERENCE.map((code) => {
              const on = differences.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setDifferences((current) => (on ? current.filter((value) => value !== code) : [...current, code]))
                  }
                  className={cn(
                    'min-h-8 rounded-md border px-2.5 text-xs transition-colors',
                    on ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                  )}
                >
                  {quality.checkDifference[code]}
                </button>
              );
            })}
          </div>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={1000}
            className="min-h-[72px] text-sm"
            placeholder={en ? 'What did you find on the ground?' : 'ماذا وجدت على الأرض؟'}
          />
        </>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {en ? 'Cancel' : 'إلغاء'}
        </Button>
        <Button
          size="sm"
          disabled={!ready || busy}
          onClick={() => onSubmit({ result: result!, differences, notes: notes.trim() || undefined })}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {en ? 'Save' : 'حفظ'}
        </Button>
      </div>
    </div>
  );
}
