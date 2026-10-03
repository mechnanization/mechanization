'use client';

import { getLabels, isOccupiableLifecycle } from '@mechanization/shared-schemas';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';

/** The census facts the summary reads — a full building record satisfies it. */
export interface BuildingCensusFacts {
  structureType: string;
  lifecycleStatus: string;
  floorsCount: number;
  basementsCount?: number | null;
  unitsTotal: number;
  unitsSurveyed: number;
  postedNumber?: string | null;
  parcelNumber: string;
  sharedParcelNumbers?: string[] | null;
  isPartitioned?: boolean | null;
  partitionNumbers?: string[] | null;
  zoneCode?: string | null;
  zoneName?: string | null;
  /** Whether the building is placed on the map. */
  located: boolean;
}

/**
 * A building's census summary — shared by the unit matrix and «فحص الملف», so
 * a building reads the same wherever it is summarised (UX-1).
 *
 * What the structure is, then where it stands cadastrally — one fact per row,
 * as «ملخص المنشأة» shows it before saving, so a building reads the same on the
 * way in and on the way back.
 *
 * «قائم ومستعمل» is left unsaid, as it was on the badges: it is the answer on
 * nineteen buildings in twenty. The same goes for the rows that are empty for
 * most of the register — shared parcels, a posted number, damage — and for the
 * فرز, which is three-valued: «لم يُسأل» is the default for every building
 * recorded before the column existed, and printing «غير مفروزة» for those
 * would be asserting a finding nobody made — see `Building.isPartitioned`.
 */
export function BuildingCensusSummary({
  building,
  damageLevel,
  code,
  omitParcel = false,
  locale = 'ar',
}: {
  building: BuildingCensusFacts;
  /** رمز المبنى as the first row — for a screen whose header does not already carry it. */
  code?: string | null;
  /** Leaves out رقم العقار when the screen has just said it (the card's own, the same number). */
  omitParcel?: boolean;
  /** The current damage level, where the caller has read it. */
  damageLevel?: string | null;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const label = (map: Record<string, string>, value: string) => map[value] ?? value;
  const occupiable = isOccupiableLifecycle(building.lifecycleStatus as never);

  return (
    <SummaryList>
      {code ? (
        <SummaryRow label={en ? 'Building code' : 'رمز المبنى'} className="font-mono">
          {code}
        </SummaryRow>
      ) : null}

      <SummaryRow label={en ? 'Structure Type' : 'نوع المنشأة'}>
        {label(labels.structureType, building.structureType)}
      </SummaryRow>

      {building.lifecycleStatus !== 'IN_USE' ? (
        <SummaryRow label={en ? 'Construction Status' : 'الحالة الإنشائية'} className="text-warning">
          {label(labels.buildingLifecycle, building.lifecycleStatus)}
        </SummaryRow>
      ) : null}

      <SummaryRow label={en ? 'Floors' : 'الطوابق'}>
        {en ? `${building.floorsCount} floors` : `${building.floorsCount} طابق`}
        {/* The range the floors are labelled by — «B1–B2» — so it names the rows the matrix shows. */}
        {building.basementsCount
          ? ` · ${building.basementsCount === 1 ? 'B1' : `B1–B${building.basementsCount}`}`
          : ''}
      </SummaryRow>

      {/*
        A matrix on a structure nobody can be inside is an inventory, not
        outstanding work — and the ledger's figures leave it out.
      */}
      <SummaryRow
        label={en ? 'Units' : 'الوحدات'}
        className={
          occupiable && building.unitsTotal > 0 && building.unitsSurveyed === building.unitsTotal
            ? 'text-success'
            : undefined
        }
      >
        {!occupiable
          ? en
            ? `${building.unitsTotal} units recorded — not counted as survey work`
            : `${building.unitsTotal} وحدة مسجَّلة — غير محتسبة ضمن أعمال المسح`
          : en
            ? `${building.unitsSurveyed} of ${building.unitsTotal} units surveyed`
            : `${building.unitsSurveyed} من ${building.unitsTotal} وحدة ممسوحة`}
      </SummaryRow>

      {damageLevel ? (
        <SummaryRow label={en ? 'Damage level' : 'مستوى الضرر'} className="text-destructive">
          {label(labels.damageLevel, damageLevel)}
        </SummaryRow>
      ) : null}

      {building.postedNumber ? (
        <SummaryRow label={en ? 'Posted number' : 'الرقم المكتوب'} className="font-mono">
          {building.postedNumber}
        </SummaryRow>
      ) : null}

      {omitParcel ? null : (
        <SummaryRow label={en ? 'Parcel Number' : 'رقم العقار'} className="font-mono">
          {building.parcelNumber}
        </SummaryRow>
      )}

      {building.sharedParcelNumbers?.length ? (
        <SummaryRow label={en ? 'Shared parcels' : 'عقارات مشتركة'} className="font-mono">
          {building.sharedParcelNumbers.join(en ? ', ' : '، ')}
        </SummaryRow>
      ) : null}

      {/*
        The فرز with its أقسام where they have been collected: «مفروزة» on its
        own does not answer the question anybody asks it — «which قسم?». A
        ticked فرز with no numbers yet is still stated.
      */}
      {building.isPartitioned != null ? (
        <SummaryRow label={en ? 'Partition' : 'الفرز'}>
          {building.isPartitioned
            ? building.partitionNumbers?.length
              ? en
                ? `Partitioned — parts ${building.partitionNumbers.join(', ')}`
                : `مفروزة — الأقسام ${building.partitionNumbers.join('، ')}`
              : en
                ? 'Partitioned'
                : 'مفروزة'
            : en
              ? 'Not partitioned'
              : 'غير مفروزة'}
        </SummaryRow>
      ) : null}

      {building.zoneName ? (
        <SummaryRow label={en ? 'Sector' : 'القطاع'}>
          {building.zoneCode ? `${building.zoneCode} · ${building.zoneName}` : building.zoneName}
        </SummaryRow>
      ) : null}

      <SummaryRow label={en ? 'Location' : 'الموقع'} className={building.located ? undefined : 'text-muted-foreground'}>
        {building.located
          ? en
            ? 'Located'
            : 'محدَّد الموقع'
          : en
            ? 'Not on the map'
            : 'غير محدَّد على الخريطة'}
      </SummaryRow>
    </SummaryList>
  );
}
