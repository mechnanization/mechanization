'use client';

import type { BuildingTypeView } from '@mechanization/shared-schemas';

import { useTranslations } from 'next-intl';
import {
  ClipboardCheck,
} from 'lucide-react';
import {
  getLabels,
  UNZONED_CODE,
  buildingTypeName,
} from '@mechanization/shared-schemas';
import {
  type UnitWithOccupants,
} from '@/lib/api-client';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import {
  type GridUnitDraft,
} from '../unit-grid-picker';

/**
 * «ملخص المنشأة»: the read-back on the last step.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function SummaryCard({
  step,
  lastStep,
  en,
  codePreview,
  trimmedParcel,
  zoneCode,
  zoneName,
  tTypes,
  chosenType,
  locale,
  labels,
  structureType,
  floorsCount,
  basementsCount,
  gridUnits,
  hiddenUnits,
  pin,
  name,
}: {
  step: 0 | 2 | 1;
  lastStep: 0 | 2 | 1;
  en: boolean;
  codePreview: string | null;
  trimmedParcel: string;
  zoneCode: string | null;
  zoneName: string | null;
  tTypes: ReturnType<typeof useTranslations<'buildingTypes'>>;
  chosenType: BuildingTypeView | undefined;
  locale: string;
  labels: ReturnType<typeof getLabels>;
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  floorsCount: string;
  basementsCount: string;
  gridUnits: GridUnitDraft[];
  hiddenUnits: UnitWithOccupants[];
  pin: [number, number] | null;
  name: string;
}): React.JSX.Element {
  return (
    <>
      {/*
        ── Structure Summary (ملخص المنشأة) ──

        The last step only. This is a read-back of what is about to be saved
        — «راجع قبل الحفظ» — and on step 1 there is nothing to read back yet:
        it sat under a half-filled form reciting «رقم العقار —», «القطاع —»,
        «٠ وحدة», which says nothing the fields six inches above it were not
        already saying, and says it in the tone of a result. Worse, it stood
        between the form and «التالي», so every officer scrolled past a table
        of dashes to reach the button.

        On the final step it is doing its actual job: the floors and units
        come from a matrix on another screen, the sector is derived from the
        parcel rather than typed, and the entrance is a pin on a map — none
        of which is visible from here without it.
      */}
      {step === lastStep ? (
        <Card className="shadow-xs border-border/80 bg-muted/15">
          <CardHeader className="pb-3 border-b bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ClipboardCheck className="size-4 text-primary" />
                <span>{en ? 'Structure Summary' : 'ملخص المنشأة'}</span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {en ? 'Review before saving' : 'راجع قبل الحفظ'}
                </span>
                <span dir="ltr" className="font-mono text-xs font-semibold text-primary">
                  {codePreview ?? '—'}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="py-1">
            <SummaryList>
              <SummaryRow label={en ? 'Parcel Number' : 'رقم العقار'} className="font-mono font-bold">
                {trimmedParcel || '—'}
              </SummaryRow>

              <SummaryRow label={en ? 'Building Code' : 'رمز المبنى'} className="font-mono font-bold text-primary">
                {codePreview || '—'}
              </SummaryRow>

              <SummaryRow label={en ? 'Sector' : 'القطاع'}>
                {zoneCode ? `${zoneCode} · ${zoneName ?? ''}` : trimmedParcel ? UNZONED_CODE : '—'}
              </SummaryRow>

              <SummaryRow label={tTypes('picker')}>
                {chosenType ? buildingTypeName(chosenType, locale) : labels.structureType[structureType]}
              </SummaryRow>

              <SummaryRow label={en ? 'Floors & Units' : 'الطوابق والوحدات'}>
                {`${floorsCount} ${en ? 'floors' : 'طوابق'}`}
                {Number(basementsCount) > 0 ? ` + B${Number(basementsCount)}` : ''}{' '}
                · {gridUnits.length + hiddenUnits.length} {en ? 'units' : 'وحدة'}
              </SummaryRow>

              <SummaryRow
                label={en ? 'Entrance Location' : 'موقع المدخل'}
                className={pin ? 'text-success' : 'text-muted-foreground'}
              >
                {pin ? (en ? 'Pinned' : 'مُثبت') : en ? 'Desk entry' : 'غير مُثبت'}
                {name ? (
                  <span className="text-xs font-normal text-muted-foreground hidden lg:inline">
                    {' '}· {name}
                  </span>
                ) : null}
              </SummaryRow>
            </SummaryList>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
