'use client';

import * as React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  FileX2,
  Info,
  RefreshCw,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  getLabels,
  unitCorrectionDeleteSchema,
  type UnitCorrectionBlocker,
  type UnitCorrectionPreview,
  type UnitCorrectionResult,
} from '@mechanization/shared-schemas';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonText } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import {
  ApiRequestError,
  applyUnitCorrection,
  getUnitCorrectionPreview,
  unitCorrectionRefusal,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { loadSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * «حذف تصحيحي» — the SUPER_ADMIN's way to delete a unit the ordinary delete
 * refuses (`UnitCorrectionService` on the server).
 *
 * Two steps, because the first is a decision and the second is a commitment:
 *
 *  1. **المعاينة** — everything the delete would remove from the census, close
 *     on citizens' files, and change for officers' pay and the building's
 *     counts, read from the server. Nothing is asked yet. A blocker (a damage
 *     assessment) is said here, with no way forward.
 *  2. **التأكيد** — a reason, which goes on every audit row, and the unit's code
 *     typed by hand. The request quotes the preview's fingerprint; if anything
 *     changed since, the server refuses, and the dialog loads the new preview
 *     and says so, keeping the reason already typed.
 *
 * The server does all of it in one transaction with its audit rows inside, so
 * the only outcomes are "exactly what was previewed" and "nothing".
 */

type Step = 'preview' | 'confirm';

const REASON = unitCorrectionDeleteSchema.shape.reason;

export function UnitCorrectionDeleteDialog({
  open,
  onOpenChange,
  tenant,
  token,
  unitId,
  unitCode,
  locale,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  unitId: string;
  unitCode: string;
  locale: string;
  onDeleted: (result: UnitCorrectionResult) => void;
}): React.JSX.Element {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();

  const [step, setStep] = React.useState<Step>('preview');
  const [preview, setPreview] = React.useState<UnitCorrectionPreview | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  /** Why the preview on screen is a fresh one — shown above it until the next step. */
  const [notice, setNotice] = React.useState<string | null>(null);

  const [reason, setReason] = React.useState('');
  const [reasonTouched, setReasonTouched] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const next = await getUnitCorrectionPreview(tenant, token, unitId, signal);
        setPreview(next);
      } catch (caught) {
        if (signal?.aborted) return;
        setPreview(null);
        setLoadError(
          caught instanceof ApiRequestError
            ? caught.payload.message
            : en
              ? 'Could not load the preview.'
              : 'تعذّر تحميل المعاينة.',
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [tenant, token, unitId, en],
  );

  // Fresh every time it opens; nothing from an earlier attempt carries over.
  React.useEffect(() => {
    if (!open) return;
    setStep('preview');
    setPreview(null);
    setNotice(null);
    setReason('');
    setReasonTouched(false);
    setTyped('');
    setCodeError(null);
    setSubmitError(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  const reasonCheck = REASON.safeParse(reason);
  const reasonError =
    reasonTouched && !reasonCheck.success ? (reasonCheck.error.issues[0]?.message ?? null) : null;
  const codeMatches = typed.trim() === unitCode;
  const codeMismatch = typed.trim().length > 0 && !codeMatches;
  const blocked = (preview?.blockers.length ?? 0) > 0;
  const canContinue = Boolean(preview) && !loading && !blocked;
  const canDelete = canContinue && reasonCheck.success && codeMatches && !submitting;

  const submit = async (): Promise<void> => {
    if (!preview) return;
    setReasonTouched(true);
    if (!canDelete) return;
    setSubmitting(true);
    setSubmitError(null);
    setCodeError(null);
    try {
      const result = await applyUnitCorrection(tenant, token, unitId, {
        fingerprint: preview.fingerprint,
        reason: reason.trim(),
        confirmCode: typed.trim(),
      });
      toast.success(en ? `Unit ${result.unitCode} deleted` : `حُذفت الوحدة ${result.unitCode}`, {
        description: resultSummary(result, en),
      });
      onOpenChange(false);
      onDeleted(result);
    } catch (caught) {
      const refusal = unitCorrectionRefusal(caught);
      const message = caught instanceof ApiRequestError ? caught.payload.message : null;
      if (refusal === 'PREVIEW_STALE' || refusal === 'BLOCKED') {
        /*
          The record moved under the admin. Back to the preview, freshly read,
          with the reason kept — they decided once already, and what changed
          may not change that decision.
        */
        setNotice(
          message ??
            (en
              ? 'This unit changed since you opened the preview. Review the new preview.'
              : 'تغيّرت بيانات هذه الوحدة منذ فتحت المعاينة. راجع المعاينة الجديدة.'),
        );
        setTyped('');
        setStep('preview');
        await load();
      } else if (refusal === 'CONFIRM_CODE') {
        setCodeError(message ?? (en ? 'The code does not match.' : 'الرمز لا يطابق.'));
      } else {
        setSubmitError(
          message ??
            (en ? 'The unit could not be deleted. Nothing was changed.' : 'تعذّر الحذف، ولم يتغيّر شيء.'),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title = en ? `Correction delete: unit ${unitCode}` : `حذف تصحيحي للوحدة ${unitCode}`;

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent
        closeLabel={en ? 'Close' : 'إغلاق'}
        className="flex max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:p-0"
        onInteractOutside={(event) => {
          // A long preview is read, not dismissed by a stray tap beside it.
          event.preventDefault();
        }}
      >
        <DialogHeader className="border-b border-border p-4 pe-12 sm:p-6 sm:pe-12">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <ShieldAlert className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle className="leading-snug">{title}</DialogTitle>
              <DialogDescription>
                {preview
                  ? `${preview.building.code} · ${labels.unitType[preview.unit.unitType as keyof typeof labels.unitType] ?? preview.unit.unitType} · ${floorLabel(preview.unit.floor, en)}`
                  : en
                    ? 'Super admin only'
                    : 'للمدير العام فقط'}
              </DialogDescription>
            </div>
          </div>
          <Steps step={step} en={en} />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-busy={loading}>
          {step === 'preview' ? (
            <PreviewBody
              preview={preview}
              loading={loading}
              loadError={loadError}
              notice={notice}
              en={en}
              locale={locale}
              onRetry={() => void load()}
            />
          ) : preview ? (
            <ConfirmBody
              preview={preview}
              unitCode={unitCode}
              en={en}
              reason={reason}
              onReason={setReason}
              onReasonBlur={() => setReasonTouched(true)}
              reasonError={reasonError}
              typed={typed}
              onTyped={(value) => {
                setTyped(value);
                setCodeError(null);
              }}
              codeMismatch={codeMismatch}
              codeError={codeError}
              submitError={submitError}
              onSubmit={() => void submit()}
            />
          ) : null}
        </div>

        {/* Column-reversed on a phone, so the step forward is under the thumb. */}
        <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end sm:p-6">
          {step === 'preview' ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
                {en ? 'Cancel' : 'إلغاء'}
              </Button>
              <Button
                variant="destructive"
                disabled={!canContinue}
                onClick={() => {
                  setNotice(null);
                  setSubmitError(null);
                  setStep('confirm');
                }}
                className="w-full sm:w-auto"
              >
                {en ? 'Continue to confirm' : 'متابعة إلى التأكيد'}
                {en ? (
                  <ArrowRight className="size-4" aria-hidden />
                ) : (
                  <ArrowLeft className="size-4" aria-hidden />
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setStep('preview')}
                className="w-full sm:w-auto"
              >
                {en ? 'Back to preview' : 'رجوع إلى المعاينة'}
              </Button>
              <Button
                variant="destructive"
                disabled={!canDelete}
                onClick={() => void submit()}
                className="w-full sm:w-auto"
              >
                <Trash2 className="size-4" aria-hidden />
                {submitting
                  ? en
                    ? 'Deleting…'
                    : 'جارٍ الحذف…'
                  : en
                    ? `Delete ${unitCode} permanently`
                    : `حذف ${unitCode} نهائياً`}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────  Steps  ───────────────────────────────

function Steps({ step, en }: { step: Step; en: boolean }): React.JSX.Element {
  const items: Array<{ key: Step; label: string }> = [
    { key: 'preview', label: en ? 'Review' : 'المعاينة' },
    { key: 'confirm', label: en ? 'Confirm' : 'التأكيد' },
  ];
  return (
    <ol className="mt-4 flex items-center gap-2 text-xs" aria-label={en ? 'Steps' : 'الخطوات'}>
      {items.map((item, index) => {
        const current = item.key === step;
        const done = step === 'confirm' && item.key === 'preview';
        return (
          <li key={item.key} className="flex items-center gap-2" aria-current={current ? 'step' : undefined}>
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-border" /> : null}
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[11px] font-semibold',
                current
                  ? 'border-destructive bg-destructive text-destructive-foreground'
                  : done
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-border text-muted-foreground',
              )}
            >
              {index + 1}
            </span>
            <span className={cn(current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ───────────────────────────────  Step 1  ───────────────────────────────

function PreviewBody({
  preview,
  loading,
  loadError,
  notice,
  en,
  locale,
  onRetry,
}: {
  preview: UnitCorrectionPreview | null;
  loading: boolean;
  loadError: string | null;
  notice: string | null;
  en: boolean;
  locale: string;
  onRetry: () => void;
}): React.JSX.Element {
  const labels = getLabels(locale);
  const label = <K extends keyof typeof labels>(group: K, value: string | null | undefined): string => {
    if (!value) return '';
    const table = labels[group] as unknown as Record<string, string>;
    return table?.[value] ?? value;
  };

  return (
    <>
      {/* Outside the spaced column: an empty first child still pushed the column down. */}
      <p className="sr-only" aria-live="polite">
        {loading ? (en ? 'Loading the preview' : 'جارٍ تحميل المعاينة') : ''}
      </p>
      <div className="space-y-5">
        {notice ? (
          <Callout tone="info" icon={RefreshCw}>
            {notice}
          </Callout>
        ) : null}

        {loading && !preview ? <SkeletonText lines={6} /> : null}

        {loadError ? (
          <div className="space-y-3">
            <Callout tone="destructive" icon={AlertTriangle} role="alert">
              {loadError}
            </Callout>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="size-4" aria-hidden />
              {en ? 'Try again' : 'أعد المحاولة'}
            </Button>
          </div>
        ) : null}

        {preview ? (
          <div className={cn('space-y-5', loading && 'opacity-60')}>
            {preview.blockers.length > 0 ? (
              <Callout
                tone="destructive"
                icon={Ban}
                role="alert"
                title={en ? 'This unit cannot be deleted' : 'لا يمكن حذف هذه الوحدة'}
              >
                <ul className="list-disc space-y-1 ps-4">
                  {preview.blockers.map((blocker, index) => (
                    <li key={index}>{blockerText(blocker, en)}</li>
                  ))}
                </ul>
              </Callout>
            ) : (
              <Callout tone="warning" icon={ShieldAlert}>
                {en
                  ? 'The ordinary delete refuses this unit because records hang off it. This removes it anyway, all at once: either everything below happens, or nothing does. Every row removed is copied into the audit trail.'
                  : 'الحذف العادي يرفض هذه الوحدة لأن عليها سجلات. هذا الإجراء يحذفها رغم ذلك دفعة واحدة: إمّا أن يتم كل ما يلي أو لا يتم شيء، وتُحفظ نسخة كاملة من كل ما يُحذف في سجل التعديلات.'}
              </Callout>
            )}

            <Stats preview={preview} en={en} />

            {preview.nothingRecorded ? (
              <Callout tone="success" icon={CheckCircle2}>
                {en
                  ? 'Nothing is recorded against this unit. Only the unit itself is removed.'
                  : 'لا شيء مسجَّل على هذه الوحدة، فتُحذف الوحدة وحدها.'}
              </Callout>
            ) : null}

            {preview.removed.occupancies.length +
              preview.removed.visits.length +
              preview.removed.vacancies.length >
            0 ? (
              <Section
                title={en ? 'Removed from the census for good' : 'يُحذف نهائياً من سجل المسح'}
                hint={
                  en
                    ? 'Deleted with the unit. A full copy is kept in the audit trail.'
                    : 'يُحذف مع الوحدة، وتبقى نسخة كاملة منه في سجل التعديلات.'
                }
              >
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {preview.removed.occupancies.map((row) => (
                    <Row
                      key={row.id}
                      primary={row.citizenName}
                      secondary={[
                        label('occupancyRole', row.role),
                        `${en ? 'since' : 'منذ'} ${formatDate(row.fromDate)}`,
                        row.toDate
                          ? `${en ? 'ended' : 'انتهى'} ${formatDate(row.toDate)}${row.endReason ? ` (${label('occupancyEndReason', row.endReason)})` : ''}`
                          : null,
                      ]}
                      badge={en ? 'Occupancy' : 'إشغال'}
                    />
                  ))}
                  {preview.removed.visits.map((row) => (
                    <Row
                      key={row.id}
                      primary={formatDate(row.visitedAt)}
                      secondary={[label('surveyStatus', row.outcome), row.officerName]}
                      badge={en ? 'Visit' : 'زيارة'}
                    />
                  ))}
                  {preview.removed.vacancies.map((row) => (
                    <Row
                      key={row.id}
                      primary={formatDate(row.observedAt)}
                      secondary={[
                        label('vacancyBasis', row.basis),
                        row.standing ? (en ? 'standing' : 'قائم') : en ? 'lifted' : 'مرفوع',
                      ]}
                      badge={en ? 'Vacancy confirmation' : 'تأكيد شغور'}
                    />
                  ))}
                </ul>
              </Section>
            ) : null}

            {preview.files.length > 0 ? (
              <Section
                title={en ? "Closed on citizens' files" : 'يُغلق في ملفات المواطنين'}
                hint={
                  en
                    ? 'Lines are not deleted: they close as «recorded in error» and stay on the file as history.'
                    : 'لا تُحذف البنود: تُغلق بسبب «سُجِّل بالخطأ» وتبقى في الملف أثراً.'
                }
              >
                <ul className="space-y-3">
                  {preview.files.map((file) => (
                    <li key={file.citizenId} className="rounded-lg border border-border p-3">
                      <p className="font-medium">{file.citizenName}</p>
                      {file.occupancyOnly ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {en
                            ? 'Recorded in the unit with no line on their file: only the occupancy is removed.'
                            : 'مسجَّل في الوحدة دون بند في ملفه: يُحذف إشغاله فقط، ولا تتغيّر بطاقاته.'}
                        </p>
                      ) : null}
                      {file.cards.map((card) => (
                        <div key={card.cardId} className="mt-2 space-y-2">
                          <div className="flex flex-wrap items-center gap-1.5 text-sm">
                            <span className="text-muted-foreground">
                              {label('propertyType', card.propertyType)} ·{' '}
                              {label('occupancyType', card.occupancyType)}
                            </span>
                            {card.cardEnds ? (
                              <Badge variant="soft-destructive">{en ? 'Card closes' : 'تُغلق البطاقة'}</Badge>
                            ) : null}
                            {card.landlordLink === 'CLEARED' ? (
                              <Badge variant="soft-warning">
                                {en ? 'Landlord link removed' : 'يُلغى الربط بالمالك'}
                              </Badge>
                            ) : card.landlordLink === 'PRUNED' ? (
                              <Badge variant="soft-warning">
                                {en ? 'Landlord link updated' : 'يُحدَّث الربط بالمالك'}
                              </Badge>
                            ) : null}
                          </div>
                          {card.lines.length > 0 ? (
                            <ul className="space-y-1 text-sm">
                              {card.lines.map((line) => (
                                <li key={line.id} className="flex flex-wrap items-center gap-1.5">
                                  <FileX2 className="size-4 shrink-0 text-destructive" aria-hidden />
                                  <span>
                                    {[
                                      label('unitType', line.unitType) || (en ? 'Line' : 'بند'),
                                      line.floor ? lineFloor(line.floor, en) : null,
                                      line.unitArea ? `${Number(line.unitArea)} ${en ? 'm²' : 'م²'}` : null,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </span>
                                  <Badge variant="soft-muted">
                                    {line.change === 'END'
                                      ? en
                                        ? 'closes now'
                                        : 'يُغلق الآن'
                                      : en
                                        ? `re-marked (was: ${label('occupancyEndReason', line.previousEndReason) || 'ended'})`
                                        : `يُعاد وصفه (كان: ${label('occupancyEndReason', line.previousEndReason) || 'منتهٍ'})`}
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ))}
                      {file.flagsRemoved > 0 ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {en
                            ? `${file.flagsRemoved} «unverified» mark(s) on what closes are removed with it.`
                            : `تُزال ${file.flagsRemoved} علامة «غير مؤكَّد» كانت على ما يُغلق.`}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <Section title={en ? 'Other effects' : 'آثار أخرى'}>
              <ul className="space-y-2 text-sm">
                <Effect>
                  {en
                    ? `Building units: ${preview.counters.totalBefore} → ${preview.counters.totalAfter}, surveyed: ${preview.counters.surveyedBefore} → ${preview.counters.surveyedAfter}.`
                    : `وحدات المبنى: ${preview.counters.totalBefore} ← ${preview.counters.totalAfter}، الممسوحة: ${preview.counters.surveyedBefore} ← ${preview.counters.surveyedAfter}.`}
                </Effect>
                {preview.pay.map((row) => (
                  <Effect key={row.officerId}>
                    {en
                      ? `${row.officerName ?? 'An officer'} loses ${row.unitsLost} billable unit ($${row.unitsLost}): lines recorded in error earn nothing.`
                      : `${row.officerName ?? 'مراقب'}: تنقص وحداته المحتسبة ${row.unitsLost} (${row.unitsLost}$)، لأن البند المسجَّل بالخطأ لا يُحتسب.`}
                  </Effect>
                ))}
                {preview.casesUnlinked.length > 0 ? (
                  <Effect>
                    {en
                      ? `${preview.casesUnlinked.length} follow-up case(s) about this unit stay on the building with no unit. Close them from Cases if they no longer apply.`
                      : `${preview.casesUnlinked.length} حالة متابعة على هذه الوحدة تبقى على المبنى بلا وحدة. أغلقها من صفحة الحالات إن لم تعد لازمة.`}
                  </Effect>
                ) : null}
                <Effect>
                  {en ? 'Bills already issued are not changed.' : 'الفواتير الصادرة سابقاً لا تتغيّر.'}
                </Effect>
              </ul>
            </Section>
          </div>
        ) : null}
      </div>
    </>
  );
}

function Stats({ preview, en }: { preview: UnitCorrectionPreview; en: boolean }): React.JSX.Element {
  const lines = preview.files.reduce(
    (sum, file) => sum + file.cards.reduce((n, card) => n + card.lines.length, 0),
    0,
  );
  const cards = preview.files.reduce(
    (sum, file) => sum + file.cards.filter((card) => card.cardEnds).length,
    0,
  );
  const items = [
    {
      value: preview.removed.occupancies.length,
      label: en ? 'occupancies' : 'إشغال',
    },
    { value: preview.removed.visits.length, label: en ? 'visits' : 'زيارة' },
    { value: lines, label: en ? 'file lines' : 'بند في الملفات' },
    { value: cards, label: en ? 'cards closed' : 'بطاقة تُغلق' },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-muted/40 px-3 py-2">
          <dt className="sr-only">{item.label}</dt>
          <dd className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums">{item.value}</span>
            <span className="text-xs text-muted-foreground" aria-hidden>
              {item.label}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ───────────────────────────────  Step 2  ───────────────────────────────

function ConfirmBody({
  preview,
  unitCode,
  en,
  reason,
  onReason,
  onReasonBlur,
  reasonError,
  typed,
  onTyped,
  codeMismatch,
  codeError,
  submitError,
  onSubmit,
}: {
  preview: UnitCorrectionPreview;
  unitCode: string;
  en: boolean;
  reason: string;
  onReason: (value: string) => void;
  onReasonBlur: () => void;
  reasonError: string | null;
  typed: string;
  onTyped: (value: string) => void;
  codeMismatch: boolean;
  codeError: string | null;
  submitError: string | null;
  onSubmit: () => void;
}): React.JSX.Element {
  const reasonId = React.useId();
  const codeId = React.useId();
  const lines = preview.files.reduce(
    (sum, file) => sum + file.cards.reduce((n, card) => n + card.lines.length, 0),
    0,
  );

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <Callout tone="destructive" icon={AlertTriangle}>
        {en
          ? `Unit ${unitCode} is deleted from ${preview.building.code} for good${lines > 0 ? `, and ${lines} line(s) close on ${preview.files.length} file(s)` : ''}. This cannot be undone from the app; the audit trail keeps a full copy.`
          : `ستُحذف الوحدة ${unitCode} من ${preview.building.code} نهائياً${lines > 0 ? `، ويُغلق ${lines} بند في ${preview.files.length} ملف` : ''}. لا يمكن التراجع عن ذلك من التطبيق، ويحفظ سجل التعديلات نسخة كاملة.`}
      </Callout>

      <div className="space-y-2">
        <Label htmlFor={`${reasonId}-reason`}>
          {en ? 'Reason for the deletion' : 'سبب الحذف'} <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id={`${reasonId}-reason`}
          autoFocus
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          onBlur={onReasonBlur}
          aria-invalid={Boolean(reasonError)}
          aria-describedby={`${reasonId}-hint${reasonError ? ` ${reasonId}-error` : ''}`}
          placeholder={
            en
              ? 'e.g. drawn in the basement by mistake; the officer confirmed it does not exist'
              : 'مثلاً: رُسمت في القبو بالخطأ، وأكّد المراقب أنها غير موجودة'
          }
          className={cn(reasonError && 'border-destructive focus-visible:ring-destructive')}
        />
        <div className="flex items-start justify-between gap-3 text-xs">
          <p id={`${reasonId}-hint`} className="text-muted-foreground">
            {en
              ? "Shown on the building's history and on every file this touches."
              : 'يظهر في سجل تعديلات المبنى وفي كل ملف يتأثّر.'}
          </p>
          <span className="shrink-0 tabular-nums text-muted-foreground" aria-hidden>
            {reason.trim().length}/500
          </span>
        </div>
        {reasonError ? (
          <p id={`${reasonId}-error`} role="alert" className="text-sm text-destructive">
            {reasonError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${codeId}-code`}>
          {en ? (
            <>
              Type <span className="font-mono font-semibold">{unitCode}</span> to confirm
            </>
          ) : (
            <>
              اكتب <span className="font-mono font-semibold">{unitCode}</span> للتأكيد
            </>
          )}
        </Label>
        <Input
          id={`${codeId}-code`}
          dir="ltr"
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={codeMismatch || Boolean(codeError)}
          aria-describedby={codeMismatch || codeError ? `${codeId}-error` : undefined}
          className={cn(
            'font-mono',
            (codeMismatch || codeError) && 'border-destructive focus-visible:ring-destructive',
          )}
        />
        {codeMismatch || codeError ? (
          <p id={`${codeId}-error`} className="text-sm text-destructive">
            {codeError ?? (en ? `This is not ${unitCode}.` : `هذا ليس ${unitCode}.`)}
          </p>
        ) : null}
      </div>

      {submitError ? (
        <Callout tone="destructive" icon={AlertTriangle} role="alert">
          {submitError}
        </Callout>
      ) : null}

      {/* Enter in the code box submits; the visible button lives in the dialog's footer. */}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
    </form>
  );
}

// ───────────────────────────────  Pieces  ───────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({
  primary,
  secondary,
  badge,
}: {
  primary: string;
  secondary: Array<string | null | undefined>;
  badge: string;
}): React.JSX.Element {
  const rest = secondary.filter(Boolean).join(' · ');
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{primary}</p>
        {rest ? <p className="text-xs text-muted-foreground">{rest}</p> : null}
      </div>
      <Badge variant="soft-destructive" className="shrink-0">
        {badge}
      </Badge>
    </li>
  );
}

function Effect({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

const CALLOUT_TONES = {
  info: 'border-info/30 bg-info/10 text-foreground [&_svg]:text-info',
  warning: 'border-warning/40 bg-warning/10 text-foreground [&_svg]:text-warning',
  success: 'border-success/30 bg-success/10 text-foreground [&_svg]:text-success',
  destructive: 'border-destructive/30 bg-destructive/10 text-foreground [&_svg]:text-destructive',
} as const;

function Callout({
  tone,
  icon: Icon,
  title,
  role,
  children,
}: {
  tone: keyof typeof CALLOUT_TONES;
  icon: LucideIcon;
  title?: string;
  role?: 'alert' | 'status';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div role={role} className={cn('flex gap-2.5 rounded-lg border p-3 text-sm', CALLOUT_TONES[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

function floorLabel(floor: number, en: boolean): string {
  if (floor === 0) return en ? 'ground floor' : 'الطابق الأرضي';
  if (floor < 0) return en ? `basement ${-floor}` : `القبو ${-floor}`;
  return en ? `floor ${floor}` : `الطابق ${floor}`;
}

/** A line's floor is free text: «قبو 1», «الأرضي», or a number the matrix wrote. */
function lineFloor(floor: string, en: boolean): string {
  const trimmed = floor.trim();
  return /^-?\d+$/.test(trimmed) ? floorLabel(Number(trimmed), en) : trimmed;
}

function blockerText(blocker: UnitCorrectionBlocker, en: boolean): string {
  switch (blocker.kind) {
    case 'DAMAGE_ASSESSMENT':
      return en
        ? `${blocker.count} damage assessment(s) on this unit. An assessment is a compensation document and is never deleted with the unit.`
        : `على الوحدة ${blocker.count} كشف ضرر، وكشف الضرر مستند تعويض لا يُحذف مع الوحدة.`;
    case 'LINK_NAMES_OTHER_UNITS':
      return en
        ? `${blocker.citizenName}'s landlord link also covers other units. Unlink it from their file first.`
        : `ربط ملف ${blocker.citizenName} بالمالك يشمل وحدات أخرى. ألغِ الربط من ملفه أولاً.`;
    case 'UNREADABLE_LANDLORD_LINK':
      return en
        ? `${blocker.citizenName}'s landlord link could not be read, so it cannot be reverted safely.`
        : `تعذّرت قراءة ربط ملف ${blocker.citizenName} بالمالك، فلا يمكن التراجع عنه بأمان.`;
  }
}

function resultSummary(result: UnitCorrectionResult, en: boolean): string {
  const parts = en
    ? [
        result.linesEnded + result.linesReclassified > 0
          ? `${result.linesEnded + result.linesReclassified} line(s) closed`
          : null,
        result.cardsEnded > 0 ? `${result.cardsEnded} card(s) closed` : null,
        result.deleted.occupancies > 0 ? `${result.deleted.occupancies} occupancy record(s) removed` : null,
        'recorded in the audit trail',
      ]
    : [
        result.linesEnded + result.linesReclassified > 0
          ? `أُغلق ${result.linesEnded + result.linesReclassified} بند`
          : null,
        result.cardsEnded > 0 ? `وأُغلقت ${result.cardsEnded} بطاقة` : null,
        result.deleted.occupancies > 0 ? `وحُذف ${result.deleted.occupancies} إشغال` : null,
        'وسُجِّل ذلك في سجل التعديلات',
      ];
  return parts.filter(Boolean).join(en ? ', ' : '، ');
}

// ───────────────────────────────  Trigger  ───────────────────────────────

/** The signed-in staff member's role, read from the session on the client. */
export function useStaffRole(tenant: string): string | null {
  const [role, setRole] = React.useState<string | null>(null);
  React.useEffect(() => {
    const session = loadSession(tenant);
    setRole(session?.user.kind === 'STAFF' ? (session.user.role ?? null) : null);
  }, [tenant]);
  return role;
}

/**
 * «حذف تصحيحي…» beside a unit, and the dialog behind it. Renders nothing
 * unless the viewer is SUPER_ADMIN — the routes refuse everyone else anyway,
 * and a button that can only fail teaches nothing.
 */
export function UnitCorrectionDeleteButton({
  tenant,
  token,
  unit,
  locale,
  disabled,
  onDeleted,
}: {
  tenant: string;
  token: string;
  unit: { id: string; unitCode: string };
  locale: string;
  disabled?: boolean;
  onDeleted: (result: UnitCorrectionResult) => void;
}): React.JSX.Element | null {
  const role = useStaffRole(tenant);
  const [open, setOpen] = React.useState(false);
  const en = locale === 'en';
  if (role !== 'SUPER_ADMIN') return null;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <ShieldAlert className="size-4" aria-hidden />
        {en ? 'Correction delete…' : 'حذف تصحيحي…'}
      </Button>
      <UnitCorrectionDeleteDialog
        open={open}
        onOpenChange={setOpen}
        tenant={tenant}
        token={token}
        unitId={unit.id}
        unitCode={unit.unitCode}
        locale={locale}
        onDeleted={onDeleted}
      />
    </>
  );
}
