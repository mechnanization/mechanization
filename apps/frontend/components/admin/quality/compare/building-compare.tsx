'use client';

import { useTranslations } from 'next-intl';
import { getLabels } from '@mechanization/shared-schemas';
import { getBuilding, type BuildingDetail } from '@/lib/api-client';
import type { FindingSubject, QualityFinding } from '@/lib/quality-api';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { readView } from '@/lib/read-view';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { CompareShell, DifferenceSummary } from './compare-shell';
import { CompareTable, RecordHeading, row, type CompareRow } from './compare-table';

function buildingRows(
  a: BuildingDetail,
  b: BuildingDetail,
  locale: string,
  /** `qualityCompare.buildings`. */
  t: (key: string) => string,
): CompareRow[] {
  const labels = getLabels(locale);

  const coordinates = (building: BuildingDetail) =>
    building.latitude == null || building.longitude == null
      ? null
      : `${building.latitude.toFixed(5)}, ${building.longitude.toFixed(5)}`;

  return [
    row('code', t('code'), a.code, b.code),
    row('name', t('name'), a.name, b.name),
    row('posted', t('posted'), a.postedNumber, b.postedNumber),
    row('parcel', t('parcel'), a.parcelNumber, b.parcelNumber),
    row('zone', t('zone'), a.zoneName ?? a.zoneCode, b.zoneName ?? b.zoneCode),
    row(
      'structureType',
      t('structure'),
      (labels.structureType as Record<string, string>)[a.structureType] ?? a.structureType,
      (labels.structureType as Record<string, string>)[b.structureType] ?? b.structureType,
    ),
    row(
      'lifecycle',
      t('condition'),
      (labels.buildingLifecycle as Record<string, string>)[a.lifecycleStatus] ?? a.lifecycleStatus,
      (labels.buildingLifecycle as Record<string, string>)[b.lifecycleStatus] ?? b.lifecycleStatus,
    ),
    row('floors', t('floors'), a.floorsCount, b.floorsCount),
    row('basements', t('basements'), a.basementsCount ?? 0, b.basementsCount ?? 0),
    row('units', t('units'), a.unitsTotal, b.unitsTotal),
    row('surveyed', t('surveyed'), a.unitsSurveyed, b.unitsSurveyed),
    row('pin', t('pin'), coordinates(a), coordinates(b)),
    row('createdAt', t('createdAt'), formatDate(a.createdAt), formatDate(b.createdAt)),
    row('notes', t('notes'), a.notes, b.notes),
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
  const t = useTranslations('qualityCompare.buildings');

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
    errorMessage: t('loadFailed'),
    keepPrevious: true,
  });

  const view = readView(query.data, query.error);

  if (view.state === 'failed') {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <ErrorState description={view.error} offline={query.offline} onRetry={query.refetch} />
      </CompareShell>
    );
  }

  if (view.state === 'loading') {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <LoadingState label={t('loading')} />
      </CompareShell>
    );
  }

  const buildings = view.data;
  const rows = buildingRows(buildings[0], buildings[1], locale, t);

  return (
    <CompareShell finding={finding} locale={locale} onBack={onBack}>
      {view.refreshFailed ? <RefreshFailedAlert message={view.refreshFailed} onRetry={query.refetch} /> : null}
      <DifferenceSummary rows={rows} />

      <CompareTable
        headers={[
          <RecordHeading
            key="a"
            title={buildings[0].name ? `${buildings[0].code} — ${buildings[0].name}` : buildings[0].code}
            secondary={t('onParcel', { number: buildings[0].parcelNumber })}
            href={`${base}/buildings/${encodeURIComponent(buildings[0].id)}/matrix`}
            openLabel={t('openMatrix')}
          />,
          <RecordHeading
            key="b"
            title={buildings[1].name ? `${buildings[1].code} — ${buildings[1].name}` : buildings[1].code}
            secondary={t('onParcel', { number: buildings[1].parcelNumber })}
            href={`${base}/buildings/${encodeURIComponent(buildings[1].id)}/matrix`}
            openLabel={t('openMatrix')}
          />,
        ]}
        shortHeaders={[buildings[0].code, buildings[1].code]}
        rows={rows}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('verdict')}
      </p>
    </CompareShell>
  );
}
