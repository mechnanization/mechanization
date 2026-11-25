'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import type { qualityLabels } from '@mechanization/shared-schemas';
import { formatRelative } from '@/lib/dates';
import type { QualityFinding } from '@/lib/quality-api';
import { Badge } from '@/components/ui/badge';
import { FindingActions } from '../finding-actions';
import { FindingDetail, SeverityMark, subjectHref } from '../finding-parts';
import { keyOf, type View } from './finding-address';

/** The queue's six columns: what was found, on which records, by whom, when, and what to do about it. */
export function useFindingColumns({
  tenant,
  token,
  base,
  locale,
  quality,
  busy,
  setView,
  setResolving,
  reopen,
}: {
  tenant: string;
  token: string | null;
  base: string;
  locale: string;
  quality: ReturnType<typeof qualityLabels>;
  /** The `kind|subjectKey` of the finding mid-write, or null. */
  busy: string | null;
  setView: (next: View) => void;
  setResolving: (finding: QualityFinding) => void;
  reopen: (finding: QualityFinding) => void;
}): ColumnDef<QualityFinding>[] {
  const en = locale === 'en';

  const columns = useMemo<ColumnDef<QualityFinding>[]>(
    () => [
      {
        id: 'finding',
        accessorFn: (finding) => quality.findingKind[finding.kind] ?? finding.kind,
        header: en ? 'Finding' : 'الملاحظة',
        meta: {
          mobile: 'primary',
          label: en ? 'Finding' : 'الملاحظة',
          headerClassName: 'w-px',
        },
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <SeverityMark severity={row.original.severity} locale={locale} withText={false} />
            <span className="font-medium">
              {quality.findingKind[row.original.kind] ?? row.original.kind}
            </span>
            {/*
              The state rides on the name rather than holding a column of its
              own: with «إظهار المحلولة» off every row is open, so a column that
              says «مفتوحة» eleven times says nothing.
            */}
            {row.original.dismissal ? (
              <Badge variant="soft-muted">{en ? 'Resolved' : 'تم الحل'}</Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'detail',
        accessorFn: (finding) => finding.detail,
        header: en ? 'What was found' : 'ما الذي وُجد',
        /*
          The one column that takes the leftover width, and the reason the row
          has no gap in the middle of it.

          Every other column asks for exactly what its content needs (`w-px`),
          so whatever the window has to spare lands here instead of pooling
          between two columns. `max-w-0` on the cell is what makes the clipping
          work: a table column grows to its widest unbreakable content, and this
          sentence never wraps — without it the column would size itself to the
          longest finding in the register and the ellipsis would never appear.
        */
        meta: {
          label: en ? 'What was found' : 'ما الذي وُجد',
          headerClassName: 'w-full min-w-[12rem]',
          cellClassName: 'max-w-0',
        },
        // One line, clipped, with the whole sentence on hover. The row's job is
        // to be recognised at a glance; reading it is what «عرض التفاصيل» is for.
        cell: ({ row }) => (
          <FindingDetail
            detail={row.original.detail}
            locale={locale}
            tail={false}
            className="text-sm"
          />
        ),
      },
      {
        id: 'records',
        accessorFn: (finding) =>
          finding.subjects
            .map((subject) => `${subject.label} ${subject.secondary ?? ''}`)
            .join(' '),
        header: en ? 'Records' : 'السجلات',
        enableSorting: false,
        meta: {
          label: en ? 'Records' : 'السجلات',
          headerClassName: 'w-px',
        },
        cell: ({ row }) =>
          row.original.subjects.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            /*
              Names only, on one line. The reference number, the parcel and the
              second record's own numbers are all on the detail view — a queue
              row that carries every identifier a record has is four lines tall
              and still not enough to act on.
            */
            <span
              className="block max-w-[16rem] truncate"
              title={row.original.subjects
                .map((subject) =>
                  subject.secondary ? `${subject.label} — ${subject.secondary}` : subject.label,
                )
                .join(' • ')}
            >
              {row.original.subjects.map((subject, index) => (
                <span key={`${subject.kind}-${subject.id}`}>
                  {index > 0 ? <span className="text-muted-foreground"> • </span> : null}
                  <Link
                    href={subjectHref(subject, base)}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    <bdi>{subject.label}</bdi>
                  </Link>
                </span>
              ))}
            </span>
          ),
      },
      {
        id: 'officers',
        accessorFn: (finding) => finding.officers.map((officer) => officer.name).join('، '),
        header: en ? 'Filed by' : 'سجَّلها',
        enableSorting: false,
        meta: { label: en ? 'Filed by' : 'سجَّلها', headerClassName: 'w-px' },
        cell: ({ getValue }) => {
          const names = (getValue() as string) || '—';
          // Capped: a finding about two officers' filings carries both names,
          // and a shrink-to-fit column would hand the pair a third of the row.
          return (
            <span className="block max-w-[12rem] truncate text-muted-foreground" title={names}>
              {names}
            </span>
          );
        },
      },
      {
        id: 'at',
        accessorFn: (finding) => finding.at ?? '',
        header: en ? 'Last change' : 'آخر تغيير',
        meta: { label: en ? 'Last change' : 'آخر تغيير', headerClassName: 'w-px' },
        cell: ({ row }) =>
          row.original.at ? (
            <span className="text-muted-foreground">{formatRelative(row.original.at, locale)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: en ? 'Action' : 'الإجراء',
        enableSorting: false,
        enableHiding: false,
        meta: {
          mobile: 'actions',
          align: 'end',
          label: en ? 'Action' : 'الإجراء',
          // Shrink-to-fit: with the controls on one nowrap line, `w-px` makes
          // the column ask for exactly their width and leaves the rest of the
          // table to the values.
          headerClassName: 'w-px',
        },
        cell: ({ row }) => (
          <FindingActions
            finding={row.original}
            base={base}
            locale={locale}
            compact
            busy={busy === keyOf(row.original)}
            onDetails={() => setView({ mode: 'details', key: keyOf(row.original) })}
            onResolve={() => setResolving(row.original)}
            onReopen={() => reopen(row.original)}
            onCompare={() => setView({ mode: 'compare', key: keyOf(row.original) })}
            // End-aligned in the table, where the column sits against that
            // edge; left alone in the phone card, where the row is full width.
            className="sm:justify-end"
          />
        ),
      },
    ],
    /*
      `reopen` is left out on purpose — it is rebuilt every render and listing
      it would make this memo do nothing. What it closes over is listed instead:
      the tenant and the token it writes with, and `busy`, which is the only
      part of a row's controls that changes while the screen is open.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, busy, en, locale, quality, tenant, token],
  );

  return columns;
}
