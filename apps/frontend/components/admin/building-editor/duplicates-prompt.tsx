'use client';

import Link from 'next/link';
import {
  getLabels,
} from '@mechanization/shared-schemas';
import {
  type DuplicateBuildingCandidate,
} from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DistanceBadge } from './distance-badge';

/**
 * «قد يكون مسجَّلاً مسبقاً»: the structures already on the parcel, nearest first, and the reason to go on.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function DuplicatesPrompt({
  duplicates,
  en,
  trimmedParcel,
  rankedDuplicates,
  pin,
  labels,
  base,
  cancelDraft,
  acknowledgedDuplicates,
  setAcknowledgedDuplicates,
  duplicateReason,
  setDuplicateReason,
}: {
  duplicates: DuplicateBuildingCandidate[] | null;
  en: boolean;
  trimmedParcel: string;
  rankedDuplicates: { row: DuplicateBuildingCandidate; distance: number | null; index: number; }[];
  pin: [number, number] | null;
  labels: ReturnType<typeof getLabels>;
  base: string;
  cancelDraft: () => void;
  acknowledgedDuplicates: boolean;
  setAcknowledgedDuplicates: React.Dispatch<React.SetStateAction<boolean>>;
  duplicateReason: string;
  setDuplicateReason: React.Dispatch<React.SetStateAction<string>>;
}): React.JSX.Element {
  return (
    <>
      {duplicates && duplicates.length > 0 ? (
        <Alert
          variant="warning"
          title={en
            ? `${duplicates.length === 1 ? 'A structure is' : `${duplicates.length} structures are`} already recorded on parcel ${trimmedParcel}.`
            : `${duplicates.length === 1 ? 'توجد منشأة مسجَّلة مسبقاً' : `توجد ${duplicates.length} منشآت مسجَّلة مسبقاً`} على العقار ${trimmedParcel}.`}
        >
          <div className="space-y-3">

            <p className="text-xs leading-relaxed text-muted-foreground">
              {en
                ? 'If the building you are standing at is one of these, open it and record there — do not create it again.'
                : 'إن كان المبنى الذي تقف أمامه أحد هذه المنشآت فافتحه وسجِّل فيه — لا تُنشئه مرة ثانية.'}
            </p>

            <ul className="divide-y divide-border/30 rounded-lg border border-border/40 bg-background/50 text-xs">
              {rankedDuplicates.map(({ row, distance }) => (
                <li key={row.id} className="p-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <DistanceBadge metres={distance} hasPin={Boolean(pin)} en={en} />
                    <span dir="ltr" className="font-mono font-bold text-primary">
                      {row.code}
                    </span>
                    {row.name ? <span className="font-medium text-foreground">{row.name}</span> : null}
                    <span className="text-muted-foreground text-xs">
                      ({labels.structureType[row.structureType]})
                    </span>
                    {row.sharesParcel && row.ownParcelNumber ? (
                      <Badge variant="soft-info" className="text-xs">
                        {en
                          ? `Also stands on this parcel — filed under ${row.ownParcelNumber}`
                          : `يمتد على هذا العقار — عقاره الأساسي ${row.ownParcelNumber}`}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {row.postedNumber ? (
                      <span>{en ? 'Posted:' : 'مكتوب:'} <span dir="ltr" className="font-mono">{row.postedNumber}</span></span>
                    ) : null}
                    <span>{en ? `${row.unitsTotal} units` : `${row.unitsTotal} وحدة`}</span>
                    {/*
                      «هذه هي» — the answer the dialog had no button for.
                      Ticking «منفصلة» used to be the only way forward, so
                      an officer who recognised the building still had to
                      create it again or abandon the form. Opening it
                      clears the draft: the structure they meant exists.
                    */}
                    <Link
                      href={`${base}/buildings/${encodeURIComponent(row.id)}/matrix`}
                      onClick={cancelDraft}
                      className={buttonVariants({ variant: 'outline', size: 'sm', className: 'h-8 px-2.5 text-xs' })}
                    >
                      {en ? 'This is the one — open it' : 'هذه هي المنشأة — افتحها'}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>

            <div className="space-y-2 rounded-lg border border-warning/30 bg-background/60 p-2.5 text-xs text-foreground">
              <label className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={acknowledgedDuplicates}
                  onCheckedChange={(checked) => setAcknowledgedDuplicates(checked === true)}
                  className="mt-0.5"
                />
                <span className="font-medium leading-relaxed">
                  {en
                    ? 'I have verified in the field: this is a different structure from the existing ones above.'
                    : 'تحقَّقت ميدانياً: هذه منشأة منفصلة ومختلفة عن المنشآت المذكورة أعلاه.'}
                </span>
              </label>
              {/*
                The tick alone is not an answer any more. A sentence about
                what makes it separate is what a reviewer can check on the
                street, and it goes into the audit row with the distances.
              */}
              {acknowledgedDuplicates ? (
                <div className="space-y-1">
                  <Label htmlFor="duplicate-reason" className="text-xs">
                    {en ? 'What makes it a separate structure?' : 'ما الذي يجعلها منشأة منفصلة؟'}{' '}
                    <span
                      className="font-bold text-destructive"
                      aria-label={en ? 'Required field' : 'حقل إلزامي'}
                    >
                      *
                    </span>
                  </Label>
                  <Textarea
                    id="duplicate-reason"
                    value={duplicateReason}
                    onChange={(event) => setDuplicateReason(event.target.value)}
                    maxLength={300}
                    className="min-h-[64px] text-sm"
                    placeholder={
                      en
                        ? 'e.g. a separate house behind the building, with its own entrance'
                        : 'مثال: بيت مستقل خلف المبنى بمدخل منفصل'
                    }
                  />
                </div>
              ) : null}
            </div>
          </div>
        </Alert>
      ) : null}
    </>
  );
}
