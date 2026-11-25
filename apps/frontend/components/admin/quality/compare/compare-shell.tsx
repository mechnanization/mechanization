'use client';

import { ArrowLeft } from 'lucide-react';
import { qualityLabels } from '@mechanization/shared-schemas';
import type { QualityFinding } from '@/lib/quality-api';
import { FindingDetail, SeverityMark } from '../finding-parts';
import type { CompareRow } from './compare-table';

/** The screen's own chrome: back, what is being compared, and why. */
export function CompareShell({
  finding,
  locale,
  onBack,
  children,
}: {
  finding: QualityFinding;
  locale: string;
  onBack: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const en = locale === 'en';
  const quality = qualityLabels(locale);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
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
          </h2>
          <FindingDetail detail={finding.detail} locale={locale} className="text-sm" />
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * How many rows disagree — said once, above the grid.
 *
 * Phrased as label-then-number rather than «٣ حقول مختلفة», which would need
 * Arabic's four plural forms to be right at 0, 1, 2 and 11. A legend reads the
 * same either way and cannot be wrong.
 */
export function DifferenceSummary({ rows, locale }: { rows: CompareRow[]; locale: string }): React.JSX.Element {
  const en = locale === 'en';
  const conflicts = rows.filter((entry) => entry.state === 'conflict').length;
  const gaps = rows.filter((entry) => entry.state === 'gap').length;

  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2 rounded-full bg-destructive" />
        {en ? 'Fields that disagree:' : 'حقول متعارضة:'}
        <span className="font-medium tabular-nums text-foreground">{conflicts}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2 rounded-full border border-muted-foreground/40" />
        {en ? 'Asked on one record only:' : 'لم يُسأل في أحد السجلين:'}
        <span className="font-medium tabular-nums text-foreground">{gaps}</span>
      </span>
    </p>
  );
}
