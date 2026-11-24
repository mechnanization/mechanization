'use client';

import {
  type ZoneSummary,
} from '@/lib/api-client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StepField } from './step-field';

/**
 * «القطاع»: a way into the map, never a stored field.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function SectorSection({
  editing,
  zones,
  en,
  zoneId,
  setZoneId,
}: {
  editing: boolean;
  zones: ZoneSummary[];
  en: boolean;
  zoneId: string;
  setZoneId: React.Dispatch<React.SetStateAction<string>>;
}): React.JSX.Element {
  return (
    <>
      {/*
        ── 1. القطاع ──────────────────────────────────────────────

        First, and not stored anywhere.

        A building's sector is derived from its parcel's membership at
        read time (D13) — `Zone.parcelNumbers` is the one statement of
        which عقار belongs where — so this control cannot and must not
        write it. What it does is narrow the map from the whole
        municipality to a few hundred parcels somebody can actually aim
        at, which is what makes the rest of this step possible.

        Offered only while creating, and only when the register has
        sectors to offer. A correction already knows its parcel, so it
        knows its sector, and asking would be a question whose answer is
        printed two fields down.
      */}
      {!editing && zones.length > 0 ? (
        <StepField
          en={en}
          ordinal={1}
          title={en ? 'Sector (القطاع)' : 'القطاع'}

          htmlFor="building-zone"
        >
          <Select value={zoneId} onValueChange={setZoneId}>
            <SelectTrigger id="building-zone" className="h-10">
              <SelectValue placeholder={en ? 'Select a sector…' : 'اختر القطاع…'} />
            </SelectTrigger>
            <SelectContent>
              {zones.map((zone) => (
                <SelectItem key={zone.id} value={zone.id}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: zone.color }}
                    />
                    <span dir="ltr" className="font-mono text-xs">
                      {zone.code}
                    </span>
                    <span>{zone.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </StepField>
      ) : null}
    </>
  );
}
