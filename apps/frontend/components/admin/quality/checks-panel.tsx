'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
import { param, useUrlState } from '@/lib/use-url-state';
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

/** The two lists, in display order — also what `?status=` may name. */
const CHECK_STATUSES = ['OPEN', 'DONE'] as const satisfies readonly QualityCheck['status'][];

/**
 * Which list is showing. The sample's period and share are not here: they are
 * what «سحب عيّنة» draws with, not a view of anything, and a reload or a link
 * from last week should not hand the next draw last week's dates.
 */
export const CHECKS_URL = { status: param.oneOf(CHECK_STATUSES, 'OPEN') };

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
  const t = useTranslations('qualityChecks');

  const [{ status }, setList] = useUrlState(CHECKS_URL);
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
    errorMessage: t('loadFailed'),
    keepPrevious: true,
  });

  const draw = async () => {
    if (!token) return;
    setDrawing(true);
    try {
      const result = await drawQualitySample(tenant, token, { from, to, percent: Number(percent) || 5 });
      toast.success(result.sampled > 0 ? t('sample.drawn', { count: result.sampled }) : t('sample.covered'));
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : t('sample.drawFailed'));
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
      toast.error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
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
              {t('sample.from')}
            </Label>
            <DatePicker id="sample-from" value={from} onChange={setFrom} max={to} locale={en ? 'en' : 'ar'} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sample-to" className="text-xs text-muted-foreground">
              {t('sample.to')}
            </Label>
            <DatePicker id="sample-to" value={to} onChange={setTo} max={isoDaysAgo(0)} locale={en ? 'en' : 'ar'} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sample-percent" className="text-xs text-muted-foreground">
              {t('sample.share')}
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
            {t('sample.draw')}
          </Button>
        </section>
      ) : null}

      <div className="flex gap-1.5">
        {CHECK_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => setList({ status: value })}
            className={cn(
              'min-h-9 rounded-md border px-3 text-sm transition-colors',
              status === value ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
            )}
          >
            {t(`status.${value}`)}
          </button>
        ))}
      </div>

      {query.error ? (
        <ErrorState description={query.error} offline={query.offline} onRetry={query.refetch} />
      ) : query.loading ? (
        <LoadingState label={t('loading')} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={t(`empty.${status}`)}
          description={canReview && status === 'OPEN' ? t('empty.openBody') : undefined}
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
                      label={t('card.type')}
                      value={labels.propertyType[card.propertyType as never] ?? card.propertyType}
                    />
                    {card.occupancyType ? (
                      <FactCell
                        label={t('card.occupancy')}
                        value={labels.occupancyType[card.occupancyType as never] ?? card.occupancyType}
                      />
                    ) : null}
                    {card.propertyNumber ? (
                      <FactCell label={t('card.parcel')} value={card.propertyNumber} />
                    ) : null}
                    {card.buildingCode || card.buildingName ? (
                      <FactCell
                        label={t('card.building')}
                        value={[card.buildingCode, card.buildingName].filter(Boolean).join(' — ')}
                      />
                    ) : null}
                    {card.units.length > 0 ? (
                      <FactCell label={t('card.units')} value={card.units.join('، ')} />
                    ) : null}
                  </FactRow>
                ))}
              </div>

              {check.status === 'DONE' ? (
                <div className="mt-3 space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                  <p>
                    <span className="font-medium">
                      {check.result === 'MATCHES' ? t('card.matches') : t('card.differs')}
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
                      t('card.recorded'),
                    )
                  }
                />
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {canReview ? (
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`assign-${check.id}`} className="text-xs text-muted-foreground">
                        {t('card.assignedTo')}
                      </Label>
                      <Select
                        value={check.assignedTo?.id ?? UNASSIGNED}
                        onValueChange={(value) =>
                          run(
                            check.id,
                            () => assignQualityCheck(tenant, token!, check.id, value === UNASSIGNED ? null : value),
                            t('card.assigned'),
                          )
                        }
                      >
                        <SelectTrigger id={`assign-${check.id}`} className="h-9 w-[12rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNASSIGNED}>{t('card.anyone')}</SelectItem>
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
                    {t('card.record')}
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
  const t = useTranslations('qualityChecks.card');
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
      {/*
        The result keeps its badge — it is the one state of the record this
        card is about, and a check with no marker is a check you have to read
        to know the answer to. Who it is assigned to is a name, so it is a name.
      */}
      {check.status === 'DONE' ? (
        <Badge variant={check.result === 'MATCHES' ? 'soft-success' : 'soft-destructive'}>
          {quality.checkResult[check.result ?? 'MATCHES']}
        </Badge>
      ) : check.assignedTo ? (
        <span className="text-xs text-muted-foreground">
          {t('forName', { name: check.assignedTo.name })}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t('unassigned')}</span>
      )}
      <span className="ms-auto text-xs text-muted-foreground">
        {t('filedBy')} {check.originalOfficer?.name ?? '—'} · {formatDate(check.filedAt)}
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
  const t = useTranslations('qualityChecks.answer');
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
            {value === 'MATCHES' ? t('matches') : t('differs')}
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
            placeholder={t('notes')}
          />
        </>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
        <Button
          size="sm"
          disabled={!ready || busy}
          onClick={() => onSubmit({ result: result!, differences, notes: notes.trim() || undefined })}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
