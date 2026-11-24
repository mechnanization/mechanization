'use client';

import {
  Plus,
  X,
} from 'lucide-react';
import {
  type ZoneSummary,
} from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { StepField } from './step-field';

/**
 * «الفرز»: one checkbox, and the أقسام only once it is ticked.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function PartitionSection({
  en,
  editing,
  zones,
  isPartitioned,
  setIsPartitioned,
  setPartitionNumbers,
  partitionNumbers,
}: {
  en: boolean;
  editing: boolean;
  zones: ZoneSummary[];
  isPartitioned: boolean;
  setIsPartitioned: React.Dispatch<React.SetStateAction<boolean>>;
  setPartitionNumbers: React.Dispatch<React.SetStateAction<string[]>>;
  partitionNumbers: string[];
}): React.JSX.Element {
  return (
    <>
      {/*
        ── 4. الفرز ───────────────────────────────────────────────

        One checkbox, and the أقسام only once it is ticked.

        It was a three-way choice — «غير محدد / مفروزة / غير مفروزة» —
        and two of those three answers earned nothing. What a transfer,
        a deed search or a resident at the counter is actually asking is
        «which قسم?», and a form that could only say "yes, partitioned"
        sent them to the survey office anyway. So the yes now opens the
        field that answers the real question.

        The asymmetry in what the box means is deliberate. Ticked is an
        officer asserting a فرز; unticked is «لم يُسأل», not «غير
        مفروزة» — so the save sends `true` or `null` and never `false`.
        An unticked box on every building ever created is not a finding
        about title that anybody made, and فرز decides whether a flat
        inside can carry a deed of its own.

        An empty list under a ticked box is allowed, and is ordinary: a
        block surveyed from the street is visibly مفروزة long before
        anyone has the قسم numbers off the صحيفة.
      */}
      <StepField
        en={en}
        ordinal={!editing && zones.length > 0 ? 4 : 3}
        title={en ? 'Partitioned on a parcel?' : 'هل الوحدة مفروزة على عقار؟'}
      >
        <div className="space-y-3">
          <label className="-mx-2 flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-accent/40">
            <Checkbox
              checked={isPartitioned}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setIsPartitioned(next);
                /*
                  Un-ticking clears the أقسام rather than parking them.

                  The server discards them for an untick anyway, so
                  leaving the rows on screen would show the officer
                  numbers that are not going to be saved — and a field
                  that silently disagrees with what it will store is
                  worse than one that is simply empty. Re-ticking starts
                  from one blank row, which is where they were anyway.
                */
                if (!next) setPartitionNumbers([]);
              }}
            />
            <span>{en ? 'Partitioned (مفروزة)' : 'مفروزة'}</span>
          </label>

          {isPartitioned ? (
            <div className="space-y-2 border-s-2 border-primary/30 ps-3">
              <p className="text-xs font-medium text-foreground/80">
                {en ? 'Partition numbers (أرقام الأقسام)' : 'أرقام الأقسام'}
              </p>

              {partitionNumbers.map((value, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={value}
                    onChange={(event) =>
                      setPartitionNumbers((current) =>
                        current.map((row, position) =>
                          position === index ? event.target.value : row,
                        ),
                      )
                    }
                    dir="ltr"
                    inputMode="numeric"
                    placeholder="12"
                    aria-label={
                      en ? `Partition number ${index + 1}` : `رقم القسم ${index + 1}`
                    }
                    className="h-10 flex-1 text-start font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setPartitionNumbers((current) =>
                        current.filter((_row, position) => position !== index),
                      )
                    }
                    aria-label={en ? 'Remove this partition' : 'حذف هذا القسم'}
                    className="size-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}

              <button
                type="button"
                onClick={() => setPartitionNumbers((current) => [...current, ''])}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-dashed border-primary/50 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
              >
                <Plus className="size-3.5 shrink-0" aria-hidden />
                {partitionNumbers.length === 0
                  ? en
                    ? 'Add a partition number'
                    : 'إضافة رقم قسم'
                  : en
                    ? 'Add another'
                    : 'إضافة رقم آخر'}
              </button>
            </div>
          ) : null}
        </div>
      </StepField>
    </>
  );
}
