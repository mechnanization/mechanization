'use client';

import {
  Plus,
  X,
} from 'lucide-react';
import {
  type ZoneSummary,
} from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StepField } from './step-field';

/**
 * «العقارات المشتركة»: the other parcels a structure stands on.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function SharedParcelsSection({
  en,
  editing,
  zones,
  sharedParcels,
  setSharedParcels,
  trimmedParcel,
}: {
  en: boolean;
  editing: boolean;
  zones: ZoneSummary[];
  sharedParcels: string[];
  setSharedParcels: React.Dispatch<React.SetStateAction<string[]>>;
  trimmedParcel: string;
}): React.JSX.Element {
  return (
    <>
      {/*
        ── 5. العقارات المشتركة ───────────────────────────────────

        A building standing on two or three adjacent عقارات is ordinary
        here, and `parcelNumber` can name only one of them: the code and
        the per-parcel suffix are derived from it (D9). Recorded here
        rather than entered as a *second building*, which is the
        duplicate §4.4's acknowledgement guard exists to catch.
      */}
      <StepField
        en={en}
        ordinal={!editing && zones.length > 0 ? 5 : 4}
        title={
          en
            ? 'Shared across more than one parcel'
            : 'إن كانت الوحدة مشتركة على أكثر من عقار'
        }

      >
        <div className="space-y-2">
          {sharedParcels.map((value, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={value}
                onChange={(event) =>
                  setSharedParcels((current) =>
                    current.map((row, position) =>
                      position === index ? event.target.value : row,
                    ),
                  )
                }
                dir="ltr"
                inputMode="numeric"
                placeholder="1043"
                aria-label={en ? `Shared parcel ${index + 1}` : `عقار مشترك ${index + 1}`}
                className="h-10 flex-1 text-start font-mono"
                invalid={Boolean(value.trim()) && value.trim() === trimmedParcel}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() =>
                  setSharedParcels((current) =>
                    current.filter((_row, position) => position !== index),
                  )
                }
                aria-label={en ? 'Remove this parcel' : 'حذف هذا العقار'}
                className="size-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}

          {/*
            Flagged rather than silently dropped. Both this form and the
            server remove the building's own عقار from the list, and an
            officer who typed it there believes they have recorded
            something — telling them why the row will vanish is cheaper
            than letting them find out it did.
          */}
          {sharedParcels.some((value) => value.trim() && value.trim() === trimmedParcel) ? (
            <p role="alert" className="text-xs leading-relaxed text-destructive">
              {en
                ? 'The building’s own parcel is already recorded above — that row will not be saved.'
                : 'عقار المبنى الأساسي مسجَّل أعلاه — لن يُحفظ هذا السطر.'}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => setSharedParcels((current) => [...current, ''])}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-dashed border-primary/50 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
          >
            <Plus className="size-3.5 shrink-0" aria-hidden />
            {sharedParcels.length === 0
              ? en
                ? 'Add a shared parcel'
                : 'إضافة عقار مشترك'
              : en
                ? 'Add another'
                : 'إضافة عقار آخر'}
          </button>
        </div>
      </StepField>
    </>
  );
}
