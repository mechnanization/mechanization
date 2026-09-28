'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, CheckCircle2, ClipboardCheck, History, Info, Loader2 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { FeeAssessmentLine } from '@mechanization/shared-schemas';
import type { BillFigure, CorrectionAffectedBill } from '@/lib/api-client';
import { describeAssessment } from '@/lib/fee-assessment';
import { formatDate } from '@/lib/dates';
import { formatLbp } from '@/lib/currency';
import { AuditEntryItem } from '@/components/admin/audit-entry';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** «محل تجاري على العقار 45 (120 م²)» — one unit a bill charged for. */
function lineLabel(line: FeeAssessmentLine, locale: string): string {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const type =
    (line.unitType && (labels.unitType as Record<string, string>)[line.unitType]) ||
    (labels.propertyType as Record<string, string>)[line.propertyType] ||
    line.propertyType;
  const where = line.propertyNumber ? (en ? ` on parcel ${line.propertyNumber}` : ` على العقار ${line.propertyNumber}`) : '';
  const area = line.unitArea != null ? ` (${line.unitArea} ${en ? 'm²' : 'م²'})` : '';
  return `${type}${where}${area}`;
}

/** Today's figure, as one phrase. */
function figureLabel(figure: BillFigure, locale: string): string {
  const en = locale === 'en';
  if (figure.kind === 'ASSESSED') return formatLbp(figure.amount, locale);
  if (figure.kind === 'NOT_TARGETED') {
    return en ? 'Not charged — holds none of what this fee is for' : 'لا تُستحق — لم يعد يحمل شيئاً مما يُفرض عليه هذا الرسم';
  }
  return en ? `Cannot be worked out: ${figure.reason}` : `لا يمكن احتسابها: ${figure.reason}`;
}

const CHANGE_KIND: Record<CorrectionAffectedBill['changes'][number]['kind'], { ar: string; en: string; tone: 'warning' | 'primary' | 'muted' }> = {
  CORRECTION: { ar: 'تصحيح', en: 'Correction', tone: 'warning' },
  DATED_CHANGE: { ar: 'تغيير فعلي', en: 'Real change', tone: 'primary' },
  EDIT: { ar: 'تعديل على السجل', en: 'Edit to the record', tone: 'muted' },
};

const STATUS_TONE: Record<string, 'destructive' | 'warning' | 'muted'> = {
  OVERDUE: 'destructive',
  PENDING_REVIEW: 'warning',
  UNPAID: 'muted',
};

/**
 * One open bill a correction affected: what it charged, what it would charge
 * today, why the two differ, and what the accountant decided.
 */
export function CorrectionBillCard({
  bill,
  locale,
  base,
  canReview,
  onReview,
}: {
  bill: CorrectionAffectedBill;
  locale: string;
  base: string;
  canReview: boolean;
  onReview: (bill: CorrectionAffectedBill) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [showChanges, setShowChanges] = useState(false);
  const changesId = useId();
  const billedHow = describeAssessment(bill.billed, locale);
  const nowHow = bill.now.kind === 'ASSESSED' ? describeAssessment(bill.now.assessment, locale) : null;
  const difference = bill.difference;

  return (
    <li className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 space-y-0.5">
          <Link
            href={`${base}/citizens/${bill.citizenId}`}
            className="text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {bill.citizenName || (en ? 'Citizen' : 'مواطن')}
          </Link>
          <p className="text-sm text-foreground">
            {bill.title}
            <span className="text-muted-foreground">
              {' · '}
              {bill.periodKey === 'ONCE' ? (en ? 'one-off' : 'لمرة واحدة') : <bdi dir="ltr">{bill.periodKey}</bdi>}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <CellTag tone={STATUS_TONE[bill.status] ?? 'muted'}>
            {(labels.paymentStatus as Record<string, string>)[bill.status] ?? bill.status}
          </CellTag>
          <span>
            {en ? 'Due' : 'تستحق'} {formatDate(bill.dueDate)}
          </span>
          <span>
            {en ? 'Raised' : 'صدرت'} {formatDate(bill.raisedAt)}
          </span>
        </div>
      </div>

      {/* ── The two figures ── */}
      <dl className="grid gap-2 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-3">
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{en ? 'On the bill' : 'في الفاتورة'}</dt>
          <dd className="font-medium tabular-nums">{formatLbp(bill.amount, locale)}</dd>
          {billedHow ? <dd className="text-xs text-muted-foreground">{billedHow}</dd> : null}
          {bill.paidAmount > 0 ? (
            <dd className="text-xs text-muted-foreground">
              {en ? 'Paid so far' : 'دُفع منها'} {formatLbp(bill.paidAmount, locale)}
            </dd>
          ) : null}
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{en ? 'If raised today' : 'لو صدرت اليوم'}</dt>
          <dd className="font-medium tabular-nums">{figureLabel(bill.now, locale)}</dd>
          {nowHow ? <dd className="text-xs text-muted-foreground">{nowHow}</dd> : null}
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{en ? 'Difference' : 'الفرق'}</dt>
          <dd
            className={cn(
              'font-semibold tabular-nums',
              difference === null ? 'text-muted-foreground' : difference < 0 ? 'text-warning' : 'text-primary',
            )}
          >
            {difference === null
              ? '—'
              : `${difference > 0 ? '+' : '−'}${formatLbp(Math.abs(difference), locale)}`}
          </dd>
          {difference !== null ? (
            <dd className="text-xs text-muted-foreground">
              {difference < 0
                ? en
                  ? 'The bill asks for more than the corrected record supports.'
                  : 'الفاتورة تطلب أكثر مما يبرّره السجل بعد التصحيح.'
                : en
                  ? 'The bill asks for less than the corrected record supports.'
                  : 'الفاتورة تطلب أقل مما يبرّره السجل بعد التصحيح.'}
            </dd>
          ) : null}
        </div>
      </dl>

      {/* ── Which units ── */}
      {bill.lines && (bill.lines.removed.length > 0 || bill.lines.added.length > 0) ? (
        <ul className="space-y-1 text-sm">
          {bill.lines.removed.map((line, index) => (
            <li key={`r${index}`} className="flex items-baseline gap-2">
              <span className="shrink-0 text-xs text-warning">{en ? 'Charged, no longer held' : 'محتسبة ولم تعد'}</span>
              <span>{lineLabel(line, locale)}</span>
            </li>
          ))}
          {bill.lines.added.map((line, index) => (
            <li key={`a${index}`} className="flex items-baseline gap-2">
              <span className="shrink-0 text-xs text-primary">{en ? 'Held, not charged' : 'تُحتسب اليوم ولم تكن'}</span>
              <span>{lineLabel(line, locale)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ── What was recorded ── */}
      <div>
        <button
          type="button"
          aria-expanded={showChanges}
          aria-controls={changesId}
          onClick={() => setShowChanges((open) => !open)}
          className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <History className="size-4" aria-hidden />
          {en
            ? `${showChanges ? 'Hide' : 'Show'} what was recorded since the bill (${bill.changes.length})`
            : `${showChanges ? 'إخفاء' : 'عرض'} ما سُجّل منذ إصدار الفاتورة (${bill.changes.length})`}
        </button>
        {showChanges ? (
          <ol id={changesId} className="mt-2 divide-y rounded-lg border px-3">
            {bill.changes.map((change) => {
              const kind = CHANGE_KIND[change.kind];
              return (
                <li key={change.entry.id} className="pt-2.5">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <CellTag tone={kind.tone}>{en ? kind.en : kind.ar}</CellTag>
                    {change.effectiveOn ? (
                      <span className="text-muted-foreground">
                        {en ? 'took effect' : 'نافذ من'} {formatDate(change.effectiveOn)}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">
                      {en ? 'recorded' : 'سُجّل في'} {formatDate(change.entry.createdAt)}
                    </span>
                  </p>
                  <ul>
                    <AuditEntryItem entry={change.entry} locale={locale} base={base} />
                  </ul>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>

      {/* ── What was decided ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {bill.review ? (
          <p className={cn('flex items-start gap-1.5 text-sm', bill.review.current ? 'text-foreground' : 'text-muted-foreground')}>
            <CheckCircle2 className={cn('mt-0.5 size-4 shrink-0', bill.review.current ? 'text-success' : 'text-muted-foreground')} aria-hidden />
            <span>
              {en ? 'Reviewed by' : 'راجعها'} {bill.review.by ?? (en ? 'a staff member' : 'موظف')} {en ? 'on' : 'في'}{' '}
              {formatDate(bill.review.at)}: «{bill.review.note}»
              {bill.review.current
                ? ''
                : en
                  ? ' — before a later correction; the figure has changed since.'
                  : ' — قبل تصحيح لاحق؛ تغيّر الرقم منذ ذلك.'}
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{en ? 'Not reviewed yet.' : 'لم تُراجَع بعد.'}</p>
        )}
        {canReview && !bill.review?.current ? (
          <Button size="sm" variant="outline" onClick={() => onReview(bill)}>
            <ClipboardCheck className="size-4" aria-hidden />
            {en ? 'Record the decision' : 'سجِّل القرار'}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Recording what was decided about a bill. It changes nothing on the bill: it
 * says who looked at it, at which figure, and what they will do.
 */
export function BillReviewDialog({
  bill,
  open,
  saving,
  error,
  locale,
  onCancel,
  onConfirm,
}: {
  bill: CorrectionAffectedBill | null;
  open: boolean;
  saving: boolean;
  error: string | null;
  locale: string;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const en = locale === 'en';
  const noteId = useId();
  const [note, setNote] = useState('');
  if (!bill) return null;
  const ready = note.trim().length >= 3;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value || saving) return;
        setNote('');
        onCancel();
      }}
    >
      <DialogContent className="max-w-lg" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span aria-hidden className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ArrowLeftRight className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>{en ? 'Record the decision' : 'تسجيل القرار'}</DialogTitle>
              <DialogDescription>
                {en
                  ? `${bill.title} for ${bill.citizenName}: ${formatLbp(bill.amount, locale)} on the bill, ${figureLabel(bill.now, locale)} today.`
                  : `${bill.title} على ${bill.citizenName}: ${formatLbp(bill.amount, locale)} في الفاتورة، و${figureLabel(bill.now, locale)} اليوم.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p className="flex items-start gap-1.5 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {en
            ? 'The bill is not changed. This records, under your name, that you reviewed it at today’s figure and what was decided. If a later correction moves the figure, the bill comes back to the list.'
            : 'لا تتغيّر الفاتورة. يُسجَّل باسمك أنك راجعتها عند رقم اليوم وما تقرّر. وإن حرّك تصحيح لاحق الرقم تعود الفاتورة إلى القائمة.'}
        </p>

        <Field label={en ? 'What was decided' : 'ما تقرّر'} htmlFor={noteId} required error={error ?? undefined}>
          <Textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={en ? 'e.g. The citizen was told; the council will decide on a refund.' : 'مثلاً: أُبلغ المواطن بالفرق، ويُعرض طلب الاسترداد على المجلس.'}
          />
        </Field>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setNote('');
              onCancel();
            }}
            disabled={saving}
            className="h-11 w-full sm:h-10 sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => onConfirm(note.trim())}
            disabled={!ready || saving}
            className="h-11 w-full sm:h-10 sm:w-auto"
          >
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ClipboardCheck className="size-4" aria-hidden />}
            {en ? 'Save the decision' : 'حفظ القرار'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
