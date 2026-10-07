'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building,
  Building2,
  DoorOpen,
  ExternalLink,
  Home,
  House,
  IdCard,
  KeyRound,
  MapPin,
  Unlink,
} from 'lucide-react';
import { getLabels, OWNER_BILLED_WHILE_ABSENT } from '@mechanization/shared-schemas';
import {
  getBuilding,
  getCitizenProfile,
  type BuildingDetail,
  type CitizenProfileProperty,
  type CitizenProfileUnit,
} from '@/lib/api-client';
import { useStaffSession } from '@/lib/use-staff-session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { param, useUrlState } from '@/lib/use-url-state';
import { formatDate, formatMonthList } from '@/lib/dates';
import { mapHref } from '@/lib/map-link';
import { formatPhone } from '@/lib/phone';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ChipGroup, SegmentedControl } from '@/components/ui/segmented-control';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { SummaryRow } from '@/components/ui/summary-list';
import { EndOwnershipDialog } from '@/components/admin/end-ownership-dialog';
import { OwnerBillingSummary } from '@/components/admin/owner-billing-panel';
import { EndTenancyDialog } from '@/components/admin/end-tenancy-dialog';
import { LandlordUnlinkDialog } from '@/components/admin/landlord-unlink-dialog';
import { PropertyScene, type PropertyTone } from '@/components/admin/property-illustrations';
import {
  CardPanel,
  CardPanels,
  PROPERTY_ICON,
  PropertyCardFrame,
  UNIT_ICON,
  UnitStatusLine,
} from '@/components/admin/property-card-frame';
import { cn } from '@/lib/utils';

type Labels = ReturnType<typeof getLabels>;
const FILTERS = ['all', 'owned', 'occupied', 'ended'] as const;
type Filter = (typeof FILTERS)[number];

/** Which cards are shown, as `?filter=` — a reload or a link to «المنتهية» keeps it. */
const URL_STATE = { filter: param.oneOf(FILTERS, 'all') };

/** A label from one of the enum maps, or the raw value where the map has none. */
function labelOf(map: Record<string, string>, key: string | null | undefined): string | null {
  if (!key) return null;
  return map[key] ?? key;
}

/** m² in either locale — «م²» on an English page is a language leak (TXT-2). */
function areaUnit(en: boolean): string {
  return en ? 'm²' : 'م²';
}

/**
 * Why a home nobody lives in is still charged to its owner — the sentence the
 * citizen file used to carry on every seasonal flat. A building is presumed
 * occupied until a تصريح بالشغور is filed (هيئة التشريع والاستشارات 725/2003)
 * and the fee is owed on actual occupancy (Law 60/1988, Art. 11).
 */
function ownerBilledHint(status: string | null | undefined, en: boolean): string | null {
  if (!(OWNER_BILLED_WHILE_ABSENT as readonly string[]).includes(status ?? '')) return null;
  return en
    ? 'Nobody lives here most of the year; the occupancy fee stays with the owner unless a vacancy declaration is filed.'
    : 'لا يسكنها أحد معظم السنة، ويبقى رسم الإشغال على المالك ما لم يُقدَّم تصريح بالشغور.';
}

/**
 * How many dwellings or premises a card stands for. A building's card lists
 * its flats; a house or a tent *is* one, with no unit rows under it — which
 * is how a citizen with a house used to read «0 وحدات». Land holds none.
 */
function unitsOf(property: CitizenProfileProperty): number {
  if (property.propertyType === 'LAND') return 0;
  const live = property.units.filter((unit) => !unit.endedAt).length;
  return live || property.unitCount || 1;
}

/**
 * «عقارات المواطن» — everything a citizen holds or lives in, one block each.
 *
 * Its own page rather than a dialog: a household with a building, a shop and a
 * plot of land is three cards with a unit list each, and a dialog over the
 * register made that a scroll inside a scroll. A page also has an address, so
 * a collector can be sent straight to it.
 *
 * Read from the same profile the citizen's file reads, flattened across
 * filings, plus the census record of each building — which is what lets a
 * block draw the actual building with the citizen's flats lit in it.
 */
export default function CitizenPropertiesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; citizenId: string }>;
}) {
  const { tenant, locale, adminPath, citizenId } = use(params);
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const queryClient = useQueryClient();

  const { token, user } = useStaffSession(tenant, base);
  const [{ filter: chosen }, setUrl] = useUrlState(URL_STATE);
  // The roles that edit a citizen's file — the same three the file itself offers these actions to.
  const auth = token && user ? { token, canEdit: EDIT_ROLES.includes(user.role) } : null;

  const profile = useStaffQuery({
    queryKey: ['citizen-profile', tenant, citizenId],
    queryFn: (tok) => getCitizenProfile(tenant, tok, citizenId),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the properties.' : 'تعذّر تحميل العقارات.',
  });
  const citizen = profile.data ?? null;

  const properties = useMemo(
    () => citizen?.registrations.flatMap((registration) => registration.properties) ?? [],
    [citizen],
  );
  /*
    The drawings, fetched after the cards and never in their way: a building
    that fails to load keeps its block, drawn generically. One request per
    building the citizen holds in — usually one or two.
  */
  const buildingIds = useMemo(
    () => [...new Set(properties.map((property) => property.buildingId).filter((id): id is string => Boolean(id)))].sort(),
    [properties],
  );
  const drawings = useStaffQuery({
    queryKey: ['citizen-property-buildings', tenant, citizenId, buildingIds.join(',')],
    queryFn: async (tok) => {
      const results = await Promise.allSettled(buildingIds.map((id) => getBuilding(tenant, tok, id)));
      const loaded = new Map<string, BuildingDetail>();
      for (const result of results) if (result.status === 'fulfilled') loaded.set(result.value.id, result.value);
      return loaded as ReadonlyMap<string, BuildingDetail>;
    },
    tenant,
    base,
    token: citizen && buildingIds.length > 0 ? token : null,
    errorMessage: en ? 'Could not load the building drawings.' : 'تعذّر تحميل رسوم المباني.',
  });
  const buildings = drawings.data ?? new Map<string, BuildingDetail>();

  /** After an action changes the file, its cards and drawings are read again. */
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant, citizenId] });
    void queryClient.invalidateQueries({ queryKey: ['citizen-property-buildings', tenant, citizenId] });
  };

  const current = properties.filter((property) => !property.endedAt);
  const counts = {
    all: properties.length,
    owned: current.filter((property) => property.occupancyType === 'OWNER').length,
    occupied: current.filter((property) => property.occupancyType !== 'OWNER').length,
    ended: properties.length - current.length,
  };
  const unitsHeld = current.reduce((total, property) => total + unitsOf(property), 0);
  /*
    A filter with nothing under it is not offered below, so one arriving from
    the URL — a stale link, or the last card of its kind just ended — reads as
    «الكل» rather than an empty page with no option selected to leave it.
  */
  const filter: Filter = chosen !== 'all' && counts[chosen] === 0 ? 'all' : chosen;

  const shown = properties.filter((property) => {
    if (filter === 'owned') return !property.endedAt && property.occupancyType === 'OWNER';
    if (filter === 'occupied') return !property.endedAt && property.occupancyType !== 'OWNER';
    if (filter === 'ended') return Boolean(property.endedAt);
    return true;
  });

  const profileHref = `${base}/citizens/${encodeURIComponent(citizenId)}`;
  // A tenant and a free occupant both live in someone else's property; the label says both.
  const occupiedLabel = en ? 'Rented or occupied' : 'إيجار أو إشغال';

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/citizens`} label={en ? 'Back' : 'رجوع'} />

      {profile.error ? (
        <ErrorState description={profile.error} onRetry={() => void profile.refetch()} retryLabel={en ? 'Try again' : 'إعادة المحاولة'} />
      ) : !citizen ? (
        <LoadingState fullHeight label={en ? 'Loading properties…' : 'جارٍ تحميل العقارات…'} />
      ) : (
        <>
          <PageHeader
            icon={Building2}
            title={citizen.fullName}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <span>{en ? 'Properties & units' : 'العقارات والوحدات'}</span>
                {citizen.referenceNumber ? (
                  <Badge variant="soft-muted" className="font-mono">
                    <bdi dir="ltr">{citizen.referenceNumber}</bdi>
                  </Badge>
                ) : null}
              </span>
            }
            actions={
              <Link href={profileHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <IdCard className="size-4" aria-hidden />
                {en ? 'Citizen file' : 'ملف المواطن'}
              </Link>
            }
          />

          {/* ── The household's holdings at a glance ─────────────── */}
          <StatStrip>
            <StatItem value={current.length} label={en ? 'Properties' : 'عقارات'} />
            <StatItem value={unitsHeld} label={en ? 'Units' : 'وحدات'} />
            <StatItem value={counts.owned} label={en ? 'Owned' : 'ملكية'} />
            <StatItem value={counts.occupied} label={occupiedLabel} />
          </StatStrip>

          {properties.length === 0 ? (
            <EmptyState
              icon={Home}
              title={en ? 'No properties on file' : 'لا توجد عقارات مسجّلة'}
              description={
                en
                  ? 'No building, flat, house or land has been recorded for this citizen yet.'
                  : 'لم يُسجَّل لهذا المواطن أي مبنى أو شقة أو منزل أو أرض بعد.'
              }
            />
          ) : (
            <>
              {/* Only the filters that would show something; the counts are in the strip above. */}
              {counts.owned + counts.occupied + counts.ended > 1 ? (
                <SegmentedControl
                  size="sm"
                  aria-label={en ? 'Show' : 'عرض'}
                  value={filter}
                  onChange={(next) => setUrl({ filter: next as Filter })}
                  options={(
                    [
                      ['all', en ? 'All' : 'الكل'],
                      ['owned', en ? 'Owned' : 'ملكية'],
                      ['occupied', occupiedLabel],
                      ['ended', en ? 'Ended' : 'منتهية'],
                    ] as const
                  )
                    .filter(([key]) => key === 'all' || counts[key] > 0)
                    .map(([key, text]) => ({ value: key, label: text }))}
                />
              ) : null}

              <div className="flex flex-col gap-5">
                {shown.map((property) => (
                  <PropertyBlock
                    key={property.id}
                    property={property}
                    building={property.buildingId ? (buildings.get(property.buildingId) ?? null) : null}
                    citizenId={citizen.id}
                    labels={labels}
                    en={en}
                    base={base}
                    tenant={tenant}
                    locale={locale}
                    auth={auth}
                    onChanged={reload}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One property as a block: a picture of it, what and where it is, the
 * citizen's standing in it, and each of their units — every fact on its own
 * line, so a long list reads down rather than across.
 */
function PropertyBlock({
  property,
  building,
  citizenId,
  labels,
  en,
  base,
  tenant,
  locale,
  auth,
  onChanged,
}: {
  property: CitizenProfileProperty;
  building: BuildingDetail | null;
  citizenId: string;
  labels: Labels;
  en: boolean;
  base: string;
  tenant: string;
  locale: string;
  auth: { token: string; canEdit: boolean } | null;
  onChanged: () => void;
}) {
  /*
    The card's own corrections — they left the citizen file with its property
    cards and live here now: ending an ownership (a sale, a transfer), ending a
    tenancy (they moved out), and unlinking a landlord recorded in error. Each
    is the dialog the file used, with its own preview and audit.
  */
  const [dialog, setDialog] = useState<'ownership' | 'tenancy' | 'unlink' | null>(null);
  const editable = Boolean(auth?.canEdit) && !property.endedAt;
  const owner = property.occupancyType === 'OWNER';
  // Shares are a share *of ownership*: legacy tenant cards still carry a number that means nothing here.
  const shares = owner ? property.shares : null;
  /*
    The same three actions, gated as the citizen file gated them: an owner's
    card ends an ownership; a tenant's ends a tenancy and a free occupant's an
    occupancy (the law's words differ, so the label does); and only a
    non-owner's card has a landlord to unlink.
  */
  const actions = editable
    ? [
        ...(owner
          ? [{ key: 'ownership' as const, label: en ? 'End ownership' : 'إنهاء الملكية', icon: KeyRound }]
          : property.occupancyType === 'FREE_OCCUPANT'
            ? [{ key: 'tenancy' as const, label: en ? 'End occupancy' : 'إنهاء الإشغال', icon: DoorOpen }]
            : [{ key: 'tenancy' as const, label: en ? 'End tenancy' : 'إنهاء الإيجار', icon: DoorOpen }]),
        ...(!owner && property.landlordCitizenId
          ? [{ key: 'unlink' as const, label: en ? 'Unlink landlord' : 'فك الربط بالمالك', icon: Unlink }]
          : []),
      ]
    : [];

  const tone: PropertyTone = owner ? 'owner' : 'occupant';
  const ended = Boolean(property.endedAt);
  const typeText = labelOf(labels.propertyType, property.propertyType);
  const roleText = labelOf(labels.occupancyType, property.occupancyType);
  const lifecycle = property.buildingLifecycleStatus ?? building?.lifecycleStatus ?? null;
  const troubled = lifecycle && lifecycle !== 'IN_USE';

  /*
    The census units that are this citizen's: the ones their card lines link
    to, and any the census itself records them in now. Both, because a card
    filed before its building was surveyed links to nothing, and an owner
    recorded from the matrix may have no card line yet.
  */
  const highlight = useMemo(() => {
    const ids = new Set<string>();
    for (const unit of property.units) if (unit.unitId && !unit.endedAt) ids.add(unit.unitId);
    for (const unit of building?.units ?? []) {
      if (unit.occupants.some((occupant) => occupant.citizenId === citizenId && !occupant.toDate)) ids.add(unit.id);
    }
    return ids;
  }, [property.units, building, citizenId]);

  const litUnits = building?.units.filter((unit) => highlight.has(unit.id)) ?? [];

  /*
    The units in the order their codes run — 0203 before 0303 before 0602 —
    and one shown at a time. A household holding eight flats in one block
    used to be eight full cards down the page; now it is one, picked from
    the drawing, the chips or the arrows.
  */
  const units = useMemo(
    () =>
      [...property.units].sort((a, b) =>
        (a.unitCode ?? a.unitPostedNumber ?? '').localeCompare(b.unitCode ?? b.unitPostedNumber ?? '', 'en', {
          numeric: true,
        }),
      ),
    [property.units],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  /*
    One section at a time. Units, the property and its building stacked
    one under another made a single household's block several screens tall;
    as tabs, a block is its picture, its title and one short panel.
  */
  const hasBuilding = Boolean(building || property.buildingCode);
  const [tab, setTab] = useState<'units' | 'property' | 'building'>(
    property.units.length > 0 ? 'units' : 'property',
  );
  const index = Math.min(selectedIndex, Math.max(0, units.length - 1));
  const selectedUnit = units[index] ?? null;
  /** The lines still held — what the counts and the area describe. Ended ones stay listable. */
  const liveUnits = units.filter((unit) => !unit.endedAt);
  /*
    Co-owners are read from the units, never stored on the card (they change
    with the register). Only the current lines count.
  */
  const recordedOwners = liveUnits
    .flatMap((unit) => unit.owners ?? [])
    .filter(
      (person, at, all) =>
        all.findIndex((other) => (other.citizenId ?? other.name) === (person.citizenId ?? person.name)) === at,
    );
  const linkedIsOwner = recordedOwners.some((person) => person.citizenId === property.landlordCitizenId);
  /** A lit unit pressed in the drawing opens the card line linked to it, if there is one. */
  const selectFromDrawing = (censusUnitId: string) => {
    const at = units.findIndex((unit) => unit.unitId === censusUnitId);
    if (at >= 0) setSelectedIndex(at);
  };
  /*
    What this card is a picture *of*. A building of several units is drawn as
    itself, with the citizen's lit. A card that is one unit — a house, or a
    single shop, garage or flat — is drawn as that unit's type, from the card
    or, failing that, from the census.
  */
  const soleType =
    property.unitType ??
    (units.length === 1 ? units[0]!.unitType : null) ??
    (litUnits.length === 1 ? litUnits[0]!.unitType : null) ??
    (building?.units.length === 1 ? building.units[0]!.unitType : null);
  const manyUnits = Boolean(building && building.units.length > 1);
  /** The units the drawing cannot open — see the fallback under the panels. */
  const unreachable =
    units.length > 1
      ? units.filter((unit) => !(manyUnits && unit.unitId && highlight.has(unit.unitId)))
      : [];

  const scene = (
    <PropertyScene
      propertyType={property.propertyType}
      building={building}
      highlight={highlight}
      tone={tone}
      soleType={soleType}
      selected={selectedUnit?.unitId ?? null}
      onSelect={units.length > 0 ? selectFromDrawing : undefined}
      locale={locale}
    />
  );

  const TypeIcon = manyUnits
    ? Building2
    : soleType
      ? (UNIT_ICON[soleType] ?? House)
      : (PROPERTY_ICON[property.propertyType] ?? Building2);
  const title =
    property.buildingName ||
    building?.name ||
    (property.propertyNumber ? (en ? `Parcel ${property.propertyNumber}` : `عقار رقم ${property.propertyNumber}`) : typeText);
  const area =
    property.unitArea ??
    (liveUnits.length ? liveUnits.reduce((sum, unit) => sum + (unit.unitArea ?? 0), 0) || null : null);
  const neighbourhood = property.neighborhood || property.tentLocation;
  // Said once: a zone named the same as the neighbourhood adds nothing.
  const zone = building?.zoneName && building.zoneName !== neighbourhood ? building.zoneName : null;

  return (
    <PropertyCardFrame
      picture={scene}
      grayscale={ended}
      badgeStart={
        <Badge variant={owner ? 'soft-success' : 'soft-info'} className="backdrop-blur">
          {owner ? <KeyRound className="size-3" aria-hidden /> : <DoorOpen className="size-3" aria-hidden />}
          {roleText}
        </Badge>
      }
      badgesEnd={
        <>
          {troubled ? (
            <Badge variant={lifecycle === 'UNDER_CONSTRUCTION' || lifecycle === 'PERMITTED' ? 'soft-warning' : 'soft-destructive'}>
              {labelOf(labels.buildingLifecycle, lifecycle)}
            </Badge>
          ) : null}
          {ended ? (
            <Badge variant="soft-muted">
              {en ? 'Ended' : 'منتهية'} {property.endedAt ? formatDate(property.endedAt) : ''}
            </Badge>
          ) : null}
        </>
      }
      icon={TypeIcon}
      tone={tone}
      title={title}
      neighbourhood={neighbourhood}
      zone={zone}
      stats={
        <>
          {liveUnits.length > 0 ? (
            <StatItem
              value={liveUnits.length}
              label={owner ? (en ? 'Units owned' : 'وحدات يملكها') : en ? 'Units' : 'وحدات'}
              className={owner ? 'text-success' : 'text-info'}
            />
          ) : null}
          {building ? <StatItem value={building.floorsCount} label={en ? 'Floors' : 'طوابق'} /> : null}
          {building && building.unitsTotal > 1 ? (
            <StatItem value={building.unitsTotal} label={en ? 'Units in building' : 'وحدات المبنى'} />
          ) : null}
          {area ? <StatItem value={area} unit={areaUnit(en)} label={en ? 'Area' : 'المساحة'} /> : null}
          {shares != null ? (
            <StatItem value={Math.round((shares / 2400) * 100)} unit="%" label={en ? 'Of the plot' : 'من العقار'} />
          ) : null}
        </>
      }
      tabs={[
        ...(units.length > 0
          ? [{ value: 'units', label: en ? `Units (${liveUnits.length})` : `الوحدات (${liveUnits.length})` }]
          : []),
        { value: 'property', label: en ? 'Property' : 'العقار' },
        ...(hasBuilding ? [{ value: 'building', label: en ? 'Building' : 'المبنى' }] : []),
      ]}
      tab={tab}
      onTab={(next) => setTab(next as typeof tab)}
      locale={locale}
    >
      <CardPanels>
      <CardPanel active={tab === 'property'}>
        <SummaryRow label={en ? 'Property type' : 'نوع العقار'}>{typeText}</SummaryRow>
        <SummaryRow label={en ? 'Standing' : 'صفة الإشغال'}>{roleText}</SummaryRow>
        {property.neighborhood ? (
          <SummaryRow label={en ? 'Neighbourhood' : 'الحي'}>{property.neighborhood}</SummaryRow>
        ) : null}
        {building?.zoneName ? <SummaryRow label={en ? 'Zone' : 'المنطقة'}>{building.zoneName}</SummaryRow> : null}
        <SummaryRow label={en ? 'Parcel no.' : 'رقم العقار'}>
          {property.propertyNumber ? (
            <bdi dir="ltr" className="font-mono">
              {property.propertyNumber}
            </bdi>
          ) : (
            // Said, not hidden: a card with no confirmed parcel is a thing to fix.
            <span className="text-warning">{en ? 'Unverified' : 'غير مؤكَّد'}</span>
          )}
        </SummaryRow>
        {property.tentLocation ? (
          <SummaryRow label={en ? 'Tent location' : 'موقع الخيمة'}>{property.tentLocation}</SummaryRow>
        ) : null}
        {area ? (
          <SummaryRow label={en ? 'Area' : 'المساحة'} className="tabular-nums">
            {area} {areaUnit(en)}
          </SummaryRow>
        ) : null}
        {property.landType ? (
          <SummaryRow label={en ? 'Land type' : 'نوع الأرض'}>{labelOf(labels.landType, property.landType)}</SummaryRow>
        ) : null}
        {shares != null ? (
          <SummaryRow label={en ? 'Shares' : 'الأسهم'} className="tabular-nums">
            <bdi dir="ltr">
              {shares} / 2400 ({Math.round((shares / 2400) * 100)}%)
            </bdi>
          </SummaryRow>
        ) : null}
        {property.sharedRights.length > 0 ? (
          <SummaryRow label={en ? 'Shared rights' : 'الحقوق المشتركة'}>{property.sharedRights.join('، ')}</SummaryRow>
        ) : null}
        {/* A house or tent is its own unit: its type, floor, side and state are the card's. */}
        {units.length === 0 && property.propertyType !== 'LAND' ? (
          <>
            {property.unitType ? (
              <SummaryRow label={en ? 'Unit type' : 'نوع الوحدة'}>{labelOf(labels.unitType, property.unitType)}</SummaryRow>
            ) : null}
            {property.floor ? <SummaryRow label={en ? 'Floor' : 'الطابق'}>{floorText(property.floor, en)}</SummaryRow> : null}
            {property.side ? <SummaryRow label={en ? 'Side' : 'الجهة'}>{property.side}</SummaryRow> : null}
            {property.unitStatus ? (
              <SummaryRow label={en ? 'Status' : 'حالة الوحدة'}>
                <UnitStatusLine status={property.unitStatus} locale={locale} />
              </SummaryRow>
            ) : null}
          </>
        ) : null}
        {!owner && property.landlordName ? (
          <SummaryRow label={en ? 'Landlord' : 'المالك'}>
            {property.landlordCitizenId ? (
              <Link
                href={`${base}/citizens/${encodeURIComponent(property.landlordCitizenId)}/properties`}
                className="text-primary hover:underline"
              >
                {property.landlordName}
              </Link>
            ) : (
              property.landlordName
            )}
          </SummaryRow>
        ) : null}
        {/*
          The owner's name is derived from their file once linked; what the
          tenant actually said is kept and shown (a recorded user decision), so
          a link made to the wrong person can be seen to be wrong.
        */}
        {!owner &&
        property.landlordCitizenId &&
        property.landlordNameAsTyped &&
        property.landlordNameAsTyped !== property.landlordName ? (
          <SummaryRow label={en ? 'As the tenant gave it' : 'كما ذكره المستأجر'}>{property.landlordNameAsTyped}</SummaryRow>
        ) : null}
        {!owner && property.landlordPhone ? (
          <SummaryRow label={en ? 'Landlord phone' : 'هاتف المالك'}>
            <a href={`tel:${property.landlordPhone}`} dir="ltr" className="text-primary tabular-nums hover:underline">
              {formatPhone(property.landlordPhone)}
            </a>
          </SummaryRow>
        ) : null}
        {/*
          Everyone the building register records as owning these flats — a
          tenancy names the one owner the tenant deals with; heirs may be
          several. With the two warnings the file carried: a linked landlord who
          is not among them, and a tenancy linked to none of them.
        */}
        {!owner && !ended && recordedOwners.length > 0 ? (
          <SummaryRow label={en ? 'Owners in the register' : 'مالكو الوحدة في السجل'}>
            <span className="flex flex-col items-end gap-1">
              <OwnerList owners={recordedOwners} base={base} />
              {property.landlordCitizenId && !linkedIsOwner ? (
                <span className="text-xs text-warning">
                  {en
                    ? 'The linked landlord is not recorded as an owner of this unit — check the link or the unit.'
                    : 'المالك المربوط غير مسجَّل مالكاً لهذه الوحدة — راجِع الربط أو الوحدة.'}
                </span>
              ) : !property.landlordCitizenId ? (
                <span className="text-xs text-muted-foreground">
                  {en ? 'This tenancy is not linked to any of them.' : 'هذا الإيجار غير مربوط بأيٍّ منهم.'}
                </span>
              ) : null}
            </span>
          </SummaryRow>
        ) : null}
        {ended ? (
          <>
            <SummaryRow label={en ? 'Ended on' : 'تاريخ الانتهاء'}>{formatDate(property.endedAt!)}</SummaryRow>
            {property.endReason ? (
              <SummaryRow label={en ? 'Reason' : 'السبب'}>
                {labelOf(labels.occupancyEndReason, property.endReason)}
              </SummaryRow>
            ) : null}
          </>
        ) : null}
      </CardPanel>

      {/* ── The building it stands in, from the census ───────────── */}
      {hasBuilding ? (
        <CardPanel active={tab === 'building'}>
          {property.buildingCode ? (
            <SummaryRow label={en ? 'Building code' : 'رمز المبنى'} className="font-mono">
              <bdi dir="ltr">{property.buildingCode}</bdi>
            </SummaryRow>
          ) : null}
          {property.buildingPostedNumber || building?.postedNumber ? (
            <SummaryRow label={en ? 'Number on building' : 'الرقم على المبنى'} className="font-mono">
              <bdi dir="ltr">{property.buildingPostedNumber || building?.postedNumber}</bdi>
            </SummaryRow>
          ) : null}
          {building?.name ? <SummaryRow label={en ? 'Building name' : 'اسم المبنى'}>{building.name}</SummaryRow> : null}
          {building ? (
            <>
              <SummaryRow label={en ? 'Structure' : 'نوع المنشأة'}>
                {labelOf(labels.structureType, building.structureType)}
              </SummaryRow>
              <SummaryRow label={en ? 'Condition' : 'حالة المبنى'}>
                {labelOf(labels.buildingLifecycle, building.lifecycleStatus)}
              </SummaryRow>
              <SummaryRow label={en ? 'Floors' : 'عدد الطوابق'}>
                {building.floorsCount}
                {building.basementsCount ? (en ? ` + ${building.basementsCount} basement` : ` + ${building.basementsCount} قبو`) : ''}
              </SummaryRow>
              <SummaryRow label={en ? 'Units in building' : 'وحدات المبنى'}>
                {building.unitsTotal}
                <span className="ms-1 text-xs text-muted-foreground">
                  ({en ? `${building.unitsSurveyed} surveyed` : `${building.unitsSurveyed} ممسوحة`})
                </span>
              </SummaryRow>
            </>
          ) : null}
        </CardPanel>
      ) : null}

      {/* ── The units: one table each, picked from the drawing ───── */}
      {units.map((unit, at) => (
        <CardPanel key={unit.id} active={tab === 'units' && at === index}>
          <UnitRows unit={unit} labels={labels} en={en} tone={tone} base={base} ended={ended || Boolean(unit.endedAt)} />
        </CardPanel>
      ))}
      </CardPanels>

      {/*
        Picking is done on the drawing. A unit the drawing cannot show — an
        ended one, a card line never linked to the census, or a building that
        did not load — would otherwise be unreachable, so those, and only
        those, get a code to tap.
      */}
      {tab === 'units' && unreachable.length > 0 ? (
        <div className="mx-4 mb-3">
          <ChipGroup
            size="sm"
            aria-label={en ? 'Other units' : 'وحدات أخرى'}
            value={selectedUnit?.id}
            onChange={(id) => setSelectedIndex(units.findIndex((unit) => unit.id === id))}
            options={unreachable.map((unit) => ({
              value: unit.id,
              label: unit.unitCode ?? unit.unitPostedNumber ?? '—',
            }))}
          />
        </div>
      ) : null}

      {property.buildingId || actions.length > 0 || property.latitude != null ? (
        <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2.5">
          <div className="flex flex-wrap gap-2">
            {actions.map(({ key, label, icon: Icon }) => (
              <Button key={key} type="button" variant="outline" size="sm" onClick={() => setDialog(key)}>
                <Icon className="size-4" aria-hidden />
                {label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {property.latitude != null ? (
              <Link
                href={mapHref(base, property)}
                className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <MapPin className="size-3.5" aria-hidden />
                {en ? 'View on map' : 'عرض على الخريطة'}
              </Link>
            ) : null}
            {property.buildingId ? (
              // The building's page is its matrix — there is no /buildings/:id page of its own.
              <Link
                href={`${base}/buildings/${encodeURIComponent(property.buildingId)}/matrix`}
                className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <Building2 className="size-3.5" aria-hidden />
                {en ? 'Open in building register' : 'عرض في سجل المباني'}
                <ExternalLink className="size-3 rtl:-scale-x-100" aria-hidden />
              </Link>
            ) : null}
          </div>
        </footer>
      ) : null}

      {auth && editable ? (
        <>
          {property.occupancyType === 'OWNER' ? (
            <EndOwnershipDialog
              tenant={tenant}
              token={auth.token}
              source={{ kind: 'card', propertyEntryId: property.id }}
              open={dialog === 'ownership'}
              onOpenChange={(open) => setDialog(open ? 'ownership' : null)}
              onEnded={onChanged}
              locale={locale}
            />
          ) : (
            <EndTenancyDialog
              tenant={tenant}
              token={auth.token}
              propertyEntryId={property.id}
              open={dialog === 'tenancy'}
              onOpenChange={(open) => setDialog(open ? 'tenancy' : null)}
              onEnded={onChanged}
              locale={locale}
            />
          )}
          {property.landlordCitizenId ? (
            <LandlordUnlinkDialog
              tenant={tenant}
              token={auth.token}
              propertyEntryId={property.id}
              open={dialog === 'unlink'}
              onOpenChange={(open) => setDialog(open ? 'unlink' : null)}
              onUnlinked={onChanged}
              locale={locale}
            />
          ) : null}
        </>
      ) : null}
    </PropertyCardFrame>
  );
}


/**
 * One unit: a door plate with its code and its type's icon, then every fact
 * about it on its own line. The census's status is read first, as billing
 * reads it; where the card says something else, both are shown, since that
 * disagreement is a vacancy to lift or a card to correct.
 */
function UnitRows({
  unit,
  labels,
  en,
  tone,
  base,
  ended,
}: {
  unit: CitizenProfileUnit;
  labels: Labels;
  en: boolean;
  tone: PropertyTone;
  base: string;
  /**
   * The line, or its card, has ended. The flat's *current* status, vacancy,
   * owners and seasonal record describe whoever is there now — not this
   * person, who has left — so they are not shown under an ended line.
   */
  ended: boolean;
}) {
  const Icon = (unit.unitType && UNIT_ICON[unit.unitType]) || Building;
  const status = unit.censusUnitStatus ?? unit.unitStatus;
  const disagree = Boolean(unit.censusUnitStatus && unit.unitStatus && unit.censusUnitStatus !== unit.unitStatus);
  const owners = unit.owners ?? [];
  const tOwnerBilling = useTranslations('ownerBilling');
  const seasonal = unit.unitStatus === 'SEASONAL' || unit.censusUnitStatus === 'SEASONAL';
  const billedHint = ownerBilledHint(status, en);

  return (
    <>
      <SummaryRow label={en ? 'Unit' : 'الوحدة'} className="font-mono">
        <bdi dir="ltr">{unit.unitCode ?? unit.unitPostedNumber ?? '—'}</bdi>
      </SummaryRow>
      <SummaryRow label={en ? 'Unit type' : 'نوع الوحدة'}>
        <span className="inline-flex items-center gap-1.5">
          <Icon className={cn('size-4', tone === 'owner' ? 'text-success' : 'text-info')} aria-hidden />
          {labelOf(labels.unitType, unit.unitType) ?? (en ? 'Unverified' : 'غير مؤكَّد')}
        </span>
      </SummaryRow>
      {unit.unitPostedNumber && unit.unitCode ? (
        <SummaryRow label={en ? 'Number on door' : 'الرقم على الباب'} className="font-mono">
          <bdi dir="ltr">{unit.unitPostedNumber}</bdi>
        </SummaryRow>
      ) : null}
      {unit.floor ? <SummaryRow label={en ? 'Floor' : 'الطابق'}>{floorText(unit.floor, en)}</SummaryRow> : null}
      {unit.side ? <SummaryRow label={en ? 'Side' : 'الجهة'}>{unit.side}</SummaryRow> : null}
      <SummaryRow label={en ? 'Area' : 'المساحة'} className="tabular-nums">
        {unit.unitArea ? (
          `${unit.unitArea} ${areaUnit(en)}`
        ) : (
          <span className="text-muted-foreground">{en ? 'Not recorded' : 'غير مسجَّلة'}</span>
        )}
      </SummaryRow>
      {ended ? (
        unit.endedAt ? (
          <SummaryRow label={en ? 'Ended on' : 'تاريخ الانتهاء'}>{formatDate(unit.endedAt)}</SummaryRow>
        ) : null
      ) : (
        <>
          {status ? (
            <SummaryRow label={disagree ? (en ? 'Status (register)' : 'الحالة في السجل') : en ? 'Status' : 'حالة الوحدة'}>
              <span className="flex flex-col items-end gap-0.5">
                <UnitStatusLine status={status} locale={en ? 'en' : 'ar'} />
                {billedHint ? <span className="text-xs text-muted-foreground">{billedHint}</span> : null}
              </span>
            </SummaryRow>
          ) : null}
          {disagree ? (
            <SummaryRow label={en ? 'Status (card)' : 'الحالة على البطاقة'} className="text-warning">
              <UnitStatusLine status={unit.unitStatus} locale={en ? 'en' : 'ar'} />
            </SummaryRow>
          ) : null}
          {/*
            «تأكيد الشغور» — stated with what it rests on and when, never reduced
            to a word: the owner disputing a bill and the resident disputing
            its absence are both entitled to read which basis an officer had
            (Shura 518/2007 — a missing declaration does not make an occupied
            flat vacant, and a neighbour's word is not a تصريح).
          */}
          {unit.vacancy ? (
            <>
              <SummaryRow label={en ? 'Confirmed vacant' : 'شغور مؤكَّد'}>{formatDate(unit.vacancy.observedAt)}</SummaryRow>
              <SummaryRow label={en ? 'Basis' : 'المستند'}>
                {unit.vacancy.basis
                  ? labelOf(labels.vacancyBasis, unit.vacancy.basis)
                  : en
                    ? 'Not recorded (backfilled)'
                    : 'دون مستند مسجَّل (سجل مُرحَّل)'}
              </SummaryRow>
            </>
          ) : null}
          {owners.length > 0 ? (
            <SummaryRow label={owners.length > 1 ? (en ? 'Co-owners' : 'المالكون') : en ? 'Owner' : 'المالك'}>
              <OwnerList owners={owners} base={base} />
            </SummaryRow>
          ) : null}
          {/* «توزيع الرسم على المالكين» (0075): how this co-owned flat is billed, and this owner's part. */}
          {unit.ownerBilling && tone === 'owner' ? (
            <SummaryRow label={tOwnerBilling('fileLabel')}>
              <OwnerBillingSummary billing={unit.ownerBilling} locale={en ? 'en' : 'ar'} perspective="file" />
            </SummaryRow>
          ) : null}
          {/*
            «مسكن موسمي» — what the council's decision to shorten the fee would
            rest on: the months present, the last stay, and any declaration.
          */}
          {seasonal ? (
            <>
              <SummaryRow label={en ? 'Present' : 'أشهر الحضور'}>
                {unit.presenceMonths?.length ? (
                  formatMonthList(unit.presenceMonths, en ? 'en' : 'ar')
                ) : (
                  <span className="text-muted-foreground">{en ? 'Not recorded' : 'لم يُسجَّل'}</span>
                )}
              </SummaryRow>
              {unit.ownerLastStayAt ? (
                <SummaryRow label={en ? 'Last stay' : 'آخر إقامة'}>{formatDate(unit.ownerLastStayAt)}</SummaryRow>
              ) : null}
              {unit.vacancyDeclaredAt ? (
                <SummaryRow label={en ? 'Vacancy declared' : 'تصريح بالشغور'}>{formatDate(unit.vacancyDeclaredAt)}</SummaryRow>
              ) : null}
            </>
          ) : null}
        </>
      )}
      {unit.sharedRights.length > 0 ? (
        <SummaryRow label={en ? 'Shared rights' : 'الحقوق المشتركة'}>{unit.sharedRights.join('، ')}</SummaryRow>
      ) : null}
    </>
  );
}

/**
 * Owners as the register records them: a link to each file, the phone to call
 * — or, for an owner with none of their own, «لا يملك رقم هاتف» and the
 * relative's number, said as a relative's — and the shares out of 2400.
 */
function OwnerList({
  owners,
  base,
}: {
  owners: ReadonlyArray<NonNullable<CitizenProfileUnit['owners']>[number]>;
  base: string;
}) {
  const t = useTranslations('citizens');
  return (
    <span className="flex flex-col items-end gap-0.5">
      {owners.map((person) => (
        <span key={person.citizenId ?? person.name} className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
          {person.citizenId ? (
            <Link href={`${base}/citizens/${encodeURIComponent(person.citizenId)}`} className="text-primary hover:underline">
              {person.name}
            </Link>
          ) : (
            person.name
          )}
          {person.phone ? (
            <a
              href={`tel:${person.phone}`}
              dir="ltr"
              aria-label={t('call', { name: person.name })}
              className="text-xs tabular-nums text-primary hover:underline"
            >
              {formatPhone(person.phone)}
            </a>
          ) : person.contactPhone ? (
            <a href={`tel:${person.contactPhone}`} className="text-xs text-primary hover:underline">
              {t('contactPhone')} <bdi dir="ltr" className="tabular-nums">{formatPhone(person.contactPhone)}</bdi>
            </a>
          ) : person.hasNoPhone ? (
            <span className="text-xs text-muted-foreground">{t('noPhone')}</span>
          ) : null}
          {person.shares ? (
            <bdi dir="ltr" className="text-xs tabular-nums text-muted-foreground">
              ({person.shares}/2400)
            </bdi>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** A card's floor as it is spoken: «0» is the ground floor. */
function floorText(floor: string, en: boolean): string {
  if (floor.trim() === '0') return en ? 'Ground' : 'الأرضي';
  return floor;
}

/**
 * The roles that edit a citizen's file, and so may end a card or unlink its
 * landlord. Mirrors `@Roles` on the tenancy, ownership and unlink routes in
 * citizen.controller and the file's own `canEdit`; the server is the enforcement.
 */
const EDIT_ROLES = ['SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER'];
