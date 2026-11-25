'use client';

import { getLabels } from '@mechanization/shared-schemas';
import { getBuilding, type BuildingDetail } from '@/lib/api-client';
import type { FindingSubject, QualityFinding } from '@/lib/quality-api';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { CompareShell, DifferenceSummary } from './compare-shell';
import { CompareTable, RecordHeading, row, type CompareRow } from './compare-table';

function buildingRows(a: BuildingDetail, b: BuildingDetail, locale: string): CompareRow[] {
  const labels = getLabels(locale);
  const en = locale === 'en';

  const coordinates = (building: BuildingDetail) =>
    building.latitude == null || building.longitude == null
      ? null
      : `${building.latitude.toFixed(5)}, ${building.longitude.toFixed(5)}`;

  return [
    row('code', en ? 'Code' : 'الرمز', a.code, b.code),
    row('name', en ? 'Name' : 'اسم المبنى', a.name, b.name),
    row('posted', en ? 'Number painted on it' : 'الرقم المدهون', a.postedNumber, b.postedNumber),
    row('parcel', en ? 'Parcel' : 'رقم العقار', a.parcelNumber, b.parcelNumber),
    row('zone', en ? 'Sector' : 'القطاع', a.zoneName ?? a.zoneCode, b.zoneName ?? b.zoneCode),
    row(
      'structureType',
      en ? 'Structure' : 'نوع المنشأة',
      (labels.structureType as Record<string, string>)[a.structureType] ?? a.structureType,
      (labels.structureType as Record<string, string>)[b.structureType] ?? b.structureType,
    ),
    row(
      'lifecycle',
      en ? 'Condition' : 'الحالة الإنشائية',
      (labels.buildingLifecycle as Record<string, string>)[a.lifecycleStatus] ?? a.lifecycleStatus,
      (labels.buildingLifecycle as Record<string, string>)[b.lifecycleStatus] ?? b.lifecycleStatus,
    ),
    row('floors', en ? 'Floors' : 'عدد الطوابق', a.floorsCount, b.floorsCount),
    row('basements', en ? 'Basements' : 'عدد الأقبية', a.basementsCount ?? 0, b.basementsCount ?? 0),
    row('units', en ? 'Units' : 'عدد الوحدات', a.unitsTotal, b.unitsTotal),
    row('surveyed', en ? 'Units surveyed' : 'الوحدات الممسوحة', a.unitsSurveyed, b.unitsSurveyed),
    row('pin', en ? 'Entrance pin' : 'إحداثيات المدخل', coordinates(a), coordinates(b)),
    row('createdAt', en ? 'Created on' : 'تاريخ الإنشاء', formatDate(a.createdAt), formatDate(b.createdAt)),
    row('notes', en ? 'Notes' : 'ملاحظات', a.notes, b.notes),
  ];
}

export function BuildingCompare({
  finding,
  pair,
  tenant,
  base,
  locale,
  token,
  onBack,
}: {
  finding: QualityFinding;
  pair: { a: FindingSubject; b: FindingSubject };
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  onBack: () => void;
}): React.JSX.Element {
  const en = locale === 'en';

  const query = useStaffQuery({
    queryKey: ['quality-compare-buildings', tenant, pair.a.id, pair.b.id],
    queryFn: (tok, signal) =>
      Promise.all([
        getBuilding(tenant, tok, pair.a.id, signal),
        getBuilding(tenant, tok, pair.b.id, signal),
      ]),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the two structures.' : 'تعذّر تحميل المبنيين.',
    keepPrevious: true,
  });

  if (query.error) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <ErrorState description={query.error} offline={query.offline} onRetry={query.refetch} />
      </CompareShell>
    );
  }

  if (query.loading || !query.data) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <LoadingState label={en ? 'Loading both structures…' : 'جارٍ تحميل المبنيين…'} />
      </CompareShell>
    );
  }

  const buildings = query.data;
  const rows = buildingRows(buildings[0], buildings[1], locale);

  return (
    <CompareShell finding={finding} locale={locale} onBack={onBack}>
      <DifferenceSummary rows={rows} locale={locale} />

      <CompareTable
        locale={locale}
        headers={[
          <RecordHeading
            key="a"
            title={buildings[0].name ? `${buildings[0].code} — ${buildings[0].name}` : buildings[0].code}
            secondary={
              en ? `Parcel ${buildings[0].parcelNumber}` : `عقار ${buildings[0].parcelNumber}`
            }
            href={`${base}/buildings/${encodeURIComponent(buildings[0].id)}/matrix`}
            openLabel={en ? 'Open the matrix' : 'فتح مصفوفة الوحدات'}
          />,
          <RecordHeading
            key="b"
            title={buildings[1].name ? `${buildings[1].code} — ${buildings[1].name}` : buildings[1].code}
            secondary={
              en ? `Parcel ${buildings[1].parcelNumber}` : `عقار ${buildings[1].parcelNumber}`
            }
            href={`${base}/buildings/${encodeURIComponent(buildings[1].id)}/matrix`}
            openLabel={en ? 'Open the matrix' : 'فتح مصفوفة الوحدات'}
          />,
        ]}
        shortHeaders={[buildings[0].code, buildings[1].code]}
        rows={rows}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        {en
          ? 'Two structures metres apart on one parcel are a question, not a verdict — genuine neighbours stand that close here too. If they are one structure, correct it in the building editor; if they are two, mark this resolved with the reason.'
          : 'مبنيان متلاصقان على عقار واحد سؤال لا حكم — فالجيران الحقيقيون هنا يقفون بهذا القرب أيضاً. إن كانا مبنى واحداً فصحِّحه في محرِّر المباني، وإن كانا اثنين فعلِّم الملاحظة «تم الحل» مع السبب.'}
      </p>
    </CompareShell>
  );
}
