'use client';

import Link from 'next/link';
import { ArrowLeft, ExternalLink, FilePenLine, ShieldQuestion } from 'lucide-react';
import { qualityLabels } from '@mechanization/shared-schemas';
import type { QualityFinding } from '@/lib/quality-api';
import { formatDateTime, formatRelative } from '@/lib/dates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FactCell, FactRow } from '@/components/ui/facts';
import { cn } from '@/lib/utils';
import { FindingActions, FindingDetail, SeverityMark, subjectHref } from './finding-parts';

/**
 * «عرض التفاصيل» — one finding, and everything else the register has against
 * the same records.
 *
 * ## Why the related findings are the point
 *
 * The queue is deliberately one row per finding, because that is the unit a
 * reviewer acts on. But a record with three things wrong with it produces three
 * rows scattered across three kinds, and deciding any one of them on its own is
 * how a file gets closed three times without ever being looked at whole. A
 * structure with no entrance pin *and* four unmeasured flats *and* a near
 * neighbour on its parcel is one visit, not three.
 *
 * So the detail view is the finding plus every other open finding that names one
 * of its records — the errors underneath the row, gathered.
 */
export function FindingDetails({
  finding,
  related,
  locale,
  base,
  busyKey,
  onBack,
  onOpen,
  onResolve,
  onReopen,
  onCompare,
}: {
  finding: QualityFinding;
  /** Other findings naming one of this one's records. */
  related: QualityFinding[];
  locale: string;
  base: string;
  /** The `kind|subjectKey` of whichever finding is mid-write, or null. */
  busyKey: string | null;
  onBack: () => void;
  onOpen: (finding: QualityFinding) => void;
  onResolve: (finding: QualityFinding) => void;
  onReopen: (finding: QualityFinding) => void;
  onCompare: (finding: QualityFinding) => void;
}): React.JSX.Element {
  const en = locale === 'en';
  const quality = qualityLabels(locale);
  const key = `${finding.kind}|${finding.subjectKey}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:text-sm"
        >
          <ArrowLeft className="size-3.5 rtl:rotate-180 sm:size-4" aria-hidden />
          {en ? 'Back to quality findings' : 'رجوع إلى ملاحظات الجودة'}
        </button>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          {quality.findingKind[finding.kind] ?? finding.kind}
          <SeverityMark severity={finding.severity} locale={locale} />
          {finding.dismissal ? (
            <Badge variant="soft-muted">{en ? 'Resolved' : 'تم الحل'}</Badge>
          ) : null}
        </h2>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <FindingDetail detail={finding.detail} locale={locale} className="text-sm" />
        </div>

        <div className="px-4">
          <FactRow>
            {finding.at ? (
              <FactCell
                label={en ? 'Last change to these records' : 'آخر تغيير على هذه السجلات'}
                value={`${formatRelative(finding.at, locale)} · ${formatDateTime(finding.at)}`}
              />
            ) : null}
            {finding.officers.length > 0 ? (
              <FactCell
                label={en ? 'Filed by' : 'سجَّلها'}
                value={finding.officers.map((officer) => officer.name).join('، ')}
              />
            ) : null}
            <FactCell
              label={en ? 'How it closes' : 'كيف تُغلَق'}
              value={
                finding.dismissable
                  ? en
                    ? 'By correcting the record, or by marking it resolved with a reason.'
                    : 'بتصحيح السجل، أو بتعليمها «تم الحل» مع ذكر السبب.'
                  : en
                    ? 'Only by correcting the record itself.'
                    : 'بتصحيح السجل نفسه فقط.'
              }
            />
          </FactRow>
        </div>
      </div>

      {/*
        The records themselves, as records — a name and a reference number that
        open the file, not a row of outlined chips. A border around a value says
        «this is a control»; these are the people and the structures the finding
        is about.
      */}
      {finding.subjects.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            {en ? 'The records this is about' : 'السجلات المعنية'}
          </h3>
          <ul className="overflow-hidden rounded-xl border bg-card divide-y">
            {finding.subjects.map((subject) => (
              <li
                key={`${subject.kind}-${subject.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3"
              >
                <span className="min-w-0">
                  <Link
                    href={subjectHref(subject, base)}
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <bdi>{subject.label}</bdi>
                  </Link>
                  <span className="ms-2 text-xs text-muted-foreground">
                    {subject.kind === 'citizen'
                      ? en
                        ? 'Citizen'
                        : 'مواطن'
                      : en
                        ? 'Structure'
                        : 'منشأة'}
                    {subject.secondary ? ` · ${subject.secondary}` : ''}
                  </span>
                </span>
                {subject.kind === 'citizen' ? (
                  <Button asChild variant="ghost" size="sm" className="ms-auto h-8 gap-1.5">
                    <Link href={`${base}/citizens/${encodeURIComponent(subject.id)}/edit`}>
                      <FilePenLine className="size-3.5" aria-hidden />
                      {en ? 'Correct the file' : 'تصحيح الملف'}
                    </Link>
                  </Button>
                ) : (
                  <Button asChild variant="ghost" size="sm" className="ms-auto h-8 gap-1.5">
                    <Link href={`${base}/buildings/${encodeURIComponent(subject.id)}/edit`}>
                      <FilePenLine className="size-3.5" aria-hidden />
                      {en ? 'Edit the structure' : 'تعديل المنشأة'}
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {finding.dismissal ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-xs">
          <ShieldQuestion className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {en ? 'Marked resolved — ' : 'عُلِّمت «تم الحل» — '}
            <span className="font-medium">{finding.dismissal.reason}</span>
          </span>
          <span className="text-muted-foreground">
            {finding.dismissal.by} · {formatRelative(finding.dismissal.at, locale)}
          </span>
        </p>
      ) : null}

      {/*
        Everything else open against the same records. Empty for most findings,
        and the empty case is worth saying out loud: "nothing else is wrong with
        these two" is a fact a reviewer is deciding on.
      */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          {en ? 'Other findings on the same records' : 'ملاحظات أخرى على السجلات نفسها'}
          <span className="ms-2 text-xs font-normal text-muted-foreground tabular-nums">
            {related.length}
          </span>
        </h3>
        {related.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
            {en
              ? 'Nothing else the register can find is wrong with these records.'
              : 'لا شيء آخر يستطيع السجل أن يجده على هذه السجلات.'}
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border bg-card divide-y">
            {related.map((other) => (
              <li
                key={`${other.kind}|${other.subjectKey}`}
                className={cn(
                  'flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3',
                  other.dismissal && 'opacity-70',
                )}
              >
                <SeverityMark severity={other.severity} locale={locale} withText={false} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {quality.findingKind[other.kind] ?? other.kind}
                    {other.dismissal ? (
                      <Badge variant="soft-muted" className="ms-2">
                        {en ? 'Resolved' : 'تم الحل'}
                      </Badge>
                    ) : null}
                  </span>
                  <FindingDetail
                    detail={other.detail}
                    locale={locale}
                    className="text-xs text-muted-foreground"
                  />
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => onOpen(other)}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  {en ? 'Open' : 'فتحها'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <FindingActions
        finding={finding}
        base={base}
        locale={locale}
        busy={busyKey === key}
        showDetails={false}
        onDetails={() => undefined}
        onResolve={() => onResolve(finding)}
        onReopen={() => onReopen(finding)}
        onCompare={() => onCompare(finding)}
        className="border-t pt-4"
      />
    </div>
  );
}
