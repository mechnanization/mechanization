'use client';

import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import {
  CheckCircle2,
  Info,
} from 'lucide-react';
import {
  type ZoneSummary,
} from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  ParcelPinPicker,
} from '../parcel-pin-picker';
import { StepField } from './step-field';

/**
 * «موقع المبنى على الخريطة»: the entrance pin, and what reading the parcel off it does.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function MapSection({
  en,
  editing,
  zones,
  outline,
  outlineChecked,
  fallbackCentre,
  zoneFootprint,
  zoneParcelFeatures,
  selectedZone,
  mapParcelLabels,
  resolvedParcel,
  pin,
  applyPin,
  locale,
  pinError,
  noPinReason,
  setNoPinReason,
}: {
  en: boolean;
  editing: boolean;
  zones: ZoneSummary[];
  outline: Geometry | null;
  outlineChecked: boolean;
  fallbackCentre: [number, number] | null;
  zoneFootprint: Geometry | null;
  zoneParcelFeatures: FeatureCollection<Geometry, GeoJsonProperties> | null;
  selectedZone: ZoneSummary | null;
  mapParcelLabels: FeatureCollection<Geometry, GeoJsonProperties> | null;
  resolvedParcel: string | null;
  pin: [number, number] | null;
  applyPin: (candidate: [number, number]) => boolean;
  locale: string;
  pinError: string | null;
  noPinReason: string | null;
  setNoPinReason: React.Dispatch<React.SetStateAction<string | null>>;
}): React.JSX.Element {
  return (
    <>
      {/*
        ── 2. The map ─────────────────────────────────────────────

        Before رقم العقار rather than after it, which is the whole point
        of this reordering: an officer standing at a door knows where
        they are and not the cadastral number of the ground under them.
        The number is a fact about the map, and asking for it first was
        asking them to index the cadastre from memory.

        The pin does double duty — it is still the entrance (D19), and
        it is now also what `parcelAt` reads the parcel off. See
        `applyPin`.
      */}
      <StepField
        en={en}
        ordinal={!editing && zones.length > 0 ? 2 : 1}
        title={en ? 'Building location on the map' : 'موقع المبنى على الخريطة'}

      >
        <ParcelPinPicker
          outline={outline}
          outlineChecked={outlineChecked}
          fallbackCentre={fallbackCentre}
          zoneOutline={zoneFootprint}
          zoneParcels={zoneParcelFeatures}
          zoneColor={selectedZone?.color}
          parcelLabels={mapParcelLabels}
          parcelNumber={resolvedParcel}
          pin={pin}
          onPick={applyPin}
          locale={locale}
          className="relative h-64 sm:h-72 lg:h-80 overflow-hidden rounded-xl border border-border"
        />

        {pinError ? (
          <Alert variant="destructive" live="alert" className="mt-2">
            {pinError}
          </Alert>
        ) : null}

        {pin ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted/40 p-2.5 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-success" />
              {en ? 'Entrance pinned:' : 'تم تثبيت المدخل:'}
            </span>
            <span dir="ltr" className="font-mono font-medium text-foreground">
              {pin[1].toFixed(6)}, {pin[0].toFixed(6)}
            </span>
          </div>
        ) : editing ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5 text-xs leading-relaxed text-muted-foreground">
            <Info className="size-3.5 shrink-0 mt-0.5 text-muted-foreground" />
            <p>
              {en
                ? 'No entrance pinned yet. Saving without a pin is permitted (residents will be represented at the parcel level).'
                : 'لم يُحدَّد مدخل بعد. يمكن الحفظ دون دبوس (سيُعرض سكان المبنى على موقع العقار).'}
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-xs">
            <label className="flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={noPinReason !== null}
                onCheckedChange={(checked) => setNoPinReason(checked === true ? '' : null)}
                className="mt-0.5"
              />
              <span className="font-medium">
                {en ? 'The entrance could not be pinned now' : 'تعذّر تثبيت المدخل الآن'}
              </span>
            </label>
            {noPinReason !== null ? (
              <Textarea
                value={noPinReason}
                onChange={(event) => setNoPinReason(event.target.value)}
                maxLength={300}
                className="min-h-[56px] text-sm"
                placeholder={
                  en
                    ? 'e.g. no GPS signal; map does not load here'
                    : 'مثال: لا توجد إشارة GPS؛ الخريطة لا تُحمَّل هنا'
                }
              />
            ) : null}
          </div>
        )}
      </StepField>
    </>
  );
}
