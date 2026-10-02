'use client';

import { use, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Briefcase,
  Building,
  Building2,
  Car,
  Columns3,
  DoorOpen,
  ExternalLink,
  Home,
  House,
  IdCard,
  KeyRound,
  LandPlot,
  Loader2,
  MapPin,
  SquareDashed,
  Stethoscope,
  Store,
  Tent,
  Unlink,
  Warehouse,
} from 'lucide-react';
import { getLabels, isUnoccupied } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getBuilding,
  getCitizenProfile,
  logApiError,
  type BuildingDetail,
  type CitizenProfile,
  type CitizenProfileProperty,
  type CitizenProfileUnit,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { formatDate } from '@/lib/dates';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ChipGroup, SegmentedControl } from '@/components/ui/segmented-control';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { EndOwnershipDialog } from '@/components/admin/end-ownership-dialog';
import { EndTenancyDialog } from '@/components/admin/end-tenancy-dialog';
import { LandlordUnlinkDialog } from '@/components/admin/landlord-unlink-dialog';
import {
  BuildingElevation,
  HouseArt,
  LandArt,
  TentArt,
  UnitArt,
  type PropertyTone,
} from '@/components/admin/property-illustrations';
import { cn } from '@/lib/utils';

type Labels = ReturnType<typeof getLabels>;
type Filter = 'all' | 'owned' | 'occupied' | 'ended';

/** A label from one of the enum maps, or the raw value where the map has none. */
function labelOf(map: Record<string, string>, key: string | null | undefined): string | null {
  if (!key) return null;
  return map[key] ?? key;
}

/** Green while somebody lives there, grey while nobody does, a ring for a seasonal home. */
function occupancyDot(status: string | null | undefined): 'occupied' | 'vacant' | 'seasonal' | null {
  if (!status) return null;
  if (status === 'SEASONAL') return 'seasonal';
  return isUnoccupied(status) ? 'vacant' : 'occupied';
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
  const router = useRouter();
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [citizen, setCitizen] = useState<CitizenProfile | null>(null);
  const [buildings, setBuildings] = useState<ReadonlyMap<string, BuildingDetail>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  /** Who is looking: what the card actions need, and who may use them. */
  const [auth, setAuth] = useState<{ token: string; canEdit: boolean } | null>(null);
  /** Bumped after an action changes the file, which reloads it. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    const token = session.accessToken;
    // The roles that edit a citizen's file — the same three the file itself offers these actions to.
    setAuth({ token, canEdit: EDIT_ROLES.includes(session.user.role ?? '') });
    getCitizenProfile(tenant, token, citizenId)
      .then((profile) => {
        setCitizen(profile);
        /*
          The drawings, fetched after the cards and never in their way: a
          building that fails to load keeps its block, drawn generically.
        */
        const ids = [
          ...new Set(
            profile.registrations
              .flatMap((registration) => registration.properties)
              .map((property) => property.buildingId)
              .filter((id): id is string => Boolean(id)),
          ),
        ];
        void Promise.allSettled(ids.map((id) => getBuilding(tenant, token, id))).then((results) => {
          const loaded = new Map<string, BuildingDetail>();
          for (const result of results) {
            if (result.status === 'fulfilled') loaded.set(result.value.id, result.value);
          }
          setBuildings(loaded);
        });
      })
      .catch((caught: unknown) => {
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        setError(
          caught instanceof ApiRequestError && caught.status === 404
            ? en
              ? 'No citizen found with this ID.'
              : 'لا يوجد مواطن بهذا المعرّف.'
            : en
              ? 'Could not load the properties.'
              : 'تعذّر تحميل العقارات.',
        );
      });
  }, [tenant, base, citizenId, router, en, version]);

  const properties = useMemo(
    () => citizen?.registrations.flatMap((registration) => registration.properties) ?? [],
    [citizen],
  );
  const current = properties.filter((property) => !property.endedAt);

  const counts = {
    all: properties.length,
    owned: current.filter((property) => property.occupancyType === 'OWNER').length,
    occupied: current.filter((property) => property.occupancyType !== 'OWNER').length,
    ended: properties.length - current.length,
  };
  const unitsHeld = current.reduce((total, property) => total + unitsOf(property), 0);

  const shown = properties.filter((property) => {
    if (filter === 'owned') return !property.endedAt && property.occupancyType === 'OWNER';
    if (filter === 'occupied') return !property.endedAt && property.occupancyType !== 'OWNER';
    if (filter === 'ended') return Boolean(property.endedAt);
    return true;
  });

  const profileHref = `${base}/citizens/${encodeURIComponent(citizenId)}`;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/citizens`} label={en ? 'Back' : 'رجوع'} className="text-sm" />

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive">
          {error}
        </p>
      ) : !citizen ? (
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {en ? 'Loading properties…' : 'جارٍ تحميل العقارات…'}
        </div>
      ) : (
        <>
          {/*
            Whose properties these are, on one row at every width: the icon
            tile centred on the two lines beside it, the name as the title,
            what the page is and the file's reference under it — the reference
            as a badge, which sits on the line's centre where a dot-separated
            Latin code did not — and the way to the citizen's file at the end,
            shrinking to its icon on a phone rather than dropping under.
          */}
          <header className="flex items-center gap-3 border-b pb-4 sm:gap-4">
            <span
              aria-hidden
              className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
            >
              <Building2 className="size-6" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <h1 className="truncate text-xl font-bold leading-tight tracking-tight md:text-2xl">
                {citizen.fullName}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{en ? 'Properties & units' : 'العقارات والوحدات'}</span>
                {citizen.referenceNumber ? (
                  <Badge variant="outline" className="h-5 px-1.5 font-mono text-[11px] font-medium">
                    <bdi dir="ltr">{citizen.referenceNumber}</bdi>
                  </Badge>
                ) : null}
              </div>
            </div>
            <Link
              href={profileHref}
              aria-label={en ? 'Citizen file' : 'ملف المواطن'}
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'shrink-0' })}
            >
              <IdCard className="size-4" aria-hidden />
              <span className="hidden sm:inline">{en ? 'Citizen file' : 'ملف المواطن'}</span>
            </Link>
          </header>

          {/* ── The household's holdings at a glance ─────────────── */}
          <StatStrip>
            <StatItem value={current.length} label={en ? 'Properties' : 'عقارات'} />
            <StatItem value={unitsHeld} label={en ? 'Units' : 'وحدات'} />
            <StatItem value={counts.owned} label={en ? 'Owned' : 'ملكية'} />
            <StatItem value={counts.occupied} label={en ? 'Rented' : 'إيجار'} />
          </StatStrip>

          {properties.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
              <Home className="size-8 text-muted-foreground" aria-hidden />
              <p className="font-semibold">{en ? 'No properties on file' : 'لا توجد عقارات مسجّلة'}</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {en
                  ? 'No building, flat, house or land has been recorded for this citizen yet.'
                  : 'لم يُسجَّل لهذا المواطن أي مبنى أو شقة أو منزل أو أرض بعد.'}
              </p>
            </div>
          ) : (
            <>
              {/* Only the filters that would show something; the counts are in the strip above. */}
              {counts.owned + counts.occupied + counts.ended > 1 ? (
                <SegmentedControl
                  size="sm"
                  aria-label={en ? 'Show' : 'عرض'}
                  value={filter}
                  onChange={(next) => setFilter(next as Filter)}
                  options={(
                    [
                      ['all', en ? 'All' : 'الكل'],
                      ['owned', en ? 'Owned' : 'ملكية'],
                      ['occupied', en ? 'Rented' : 'إيجار'],
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
                    onChanged={() => setVersion((value) => value + 1)}
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
  const actions = editable
    ? [
        ...(property.occupancyType === 'OWNER'
          ? [{ key: 'ownership' as const, label: en ? 'End ownership' : 'إنهاء الملكية', icon: KeyRound }]
          : [{ key: 'tenancy' as const, label: en ? 'End tenancy' : 'إنهاء الإيجار', icon: DoorOpen }]),
        ...(property.landlordCitizenId
          ? [{ key: 'unlink' as const, label: en ? 'Unlink landlord' : 'فك الربط بالمالك', icon: Unlink }]
          : []),
      ]
    : [];

  const owner = property.occupancyType === 'OWNER';
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

  const scene =
    property.propertyType === 'LAND' ? (
      <LandArt tone={tone} shares={property.shares} landType={property.landType} />
    ) : !manyUnits && (property.propertyType === 'TENT' || building?.structureType === 'TENT_SHELTER') ? (
      <TentArt tone={tone} />
    ) : manyUnits && building ? (
      <BuildingElevation
        building={building}
        highlight={highlight}
        tone={tone}
        selected={selectedUnit?.unitId ?? null}
        onSelect={units.length > 0 ? selectFromDrawing : undefined}
      />
    ) : soleType ? (
      <UnitArt unitType={soleType} tone={tone} />
    ) : building?.structureType === 'WAREHOUSE_HANGAR' ? (
      <UnitArt unitType="WAREHOUSE" tone={tone} />
    ) : building?.structureType === 'COMMERCIAL_CENTER' ? (
      <UnitArt unitType="SHOP" tone={tone} />
    ) : property.propertyType === 'BUILDING' ? (
      <UnitArt unitType="APARTMENT" tone={tone} />
    ) : (
      <HouseArt tone={tone} />
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
    (units.length ? units.reduce((sum, unit) => sum + (unit.unitArea ?? 0), 0) || null : null);
  const neighbourhood = property.neighborhood || property.tentLocation;
  // Said once: a zone named the same as the neighbourhood adds nothing.
  const zone = building?.zoneName && building.zoneName !== neighbourhood ? building.zoneName : null;

  return (
    <article
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition-shadow hover:shadow-md md:flex-row',
        ended && 'opacity-70 grayscale-[40%]',
      )}
    >
      {/* ── The picture, with its badges over the sky ────────────── */}
      <div
        className="relative h-64 shrink-0 border-b bg-muted/40 md:order-last md:h-auto md:min-h-[22rem] md:w-80 md:border-b-0 md:border-s lg:w-96"
      >
        <div className="absolute inset-x-8 bottom-10 top-12 overflow-hidden md:inset-x-10 md:bottom-14 md:top-16">{scene}</div>
        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <Badge variant={owner ? 'soft-success' : 'soft-info'} className="backdrop-blur">
            {owner ? <KeyRound className="size-3" aria-hidden /> : <DoorOpen className="size-3" aria-hidden />}
            {roleText}
          </Badge>
          <div className="flex flex-wrap justify-end gap-1.5">
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
          </div>
        </div>
      </div>

      {/* ── The info column: title, tabs, the open panel ─────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
      {/* ── Title ────────────────────────────────────────────────── */}
      {/*
        Drawn as the page header is: the tile centred on the two lines beside
        it, the place on the second line with the zone as a badge — which
        keeps one baseline where «حي · حي» separated by a dot did not.
      */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <span
          aria-hidden
          className={cn(
            'flex size-12 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset',
            owner ? 'bg-success/10 text-success ring-success/20' : 'bg-info/10 text-info ring-info/20',
          )}
        >
          <TypeIcon className="size-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-lg font-bold leading-tight">{title}</h2>
          {neighbourhood || zone ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {neighbourhood ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <MapPin className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{neighbourhood}</span>
                </span>
              ) : null}
              {zone ? (
                <Badge variant="outline" className="h-5 px-1.5 text-[11px] font-medium">
                  {zone}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <StatStrip className="mx-4 mt-3">
        {units.length > 0 ? (
          <StatItem
            value={units.length}
            label={owner ? (en ? 'Units owned' : 'وحدات يملكها') : en ? 'Units' : 'وحدات'}
            className={owner ? 'text-success' : 'text-info'}
          />
        ) : null}
        {building ? <StatItem value={building.floorsCount} label={en ? 'Floors' : 'طوابق'} /> : null}
        {building && building.unitsTotal > 1 ? (
          <StatItem value={building.unitsTotal} label={en ? 'Units in building' : 'وحدات المبنى'} />
        ) : null}
        {area ? <StatItem value={area} unit="م²" label={en ? 'Area' : 'المساحة'} /> : null}
        {property.shares != null ? (
          <StatItem
            value={Math.round((property.shares / 2400) * 100)}
            unit="%"
            label={en ? 'Of the plot' : 'من العقار'}
          />
        ) : null}
      </StatStrip>

      {/* ── Which panel ──────────────────────────────────────────── */}
      <div className="mx-4 mt-4">
      <SegmentedControl
        size="sm"
        aria-label={en ? 'Section' : 'القسم'}
        value={tab}
        onChange={(next) => setTab(next as typeof tab)}
        options={[
          ...(property.units.length > 0
            ? [{ value: 'units', label: en ? `Units (${property.units.length})` : `الوحدات (${property.units.length})` }]
            : []),
          { value: 'property', label: en ? 'Property' : 'العقار' },
          ...(hasBuilding ? [{ value: 'building', label: en ? 'Building' : 'المبنى' }] : []),
        ]}
      />
      </div>

      {/* ── The property, one fact per line ──────────────────────── */}
      {/*
        Every panel of this block — the property, the building, and the table
        of each of its units — laid in the same grid cell, only the open one
        visible. The cell is as tall as the tallest, so nothing is ever cut off
        or scrolled, and switching tab or unit never changes the block's size.
      */}
      <div className="mx-4 my-3 grid">
      <Panel active={tab === 'property'}>
        <SummaryRow label={en ? 'Property type' : 'نوع العقار'}>{typeText}</SummaryRow>
        <SummaryRow label={en ? 'Standing' : 'صفة الإشغال'}>{roleText}</SummaryRow>
        {property.neighborhood ? (
          <SummaryRow label={en ? 'Neighbourhood' : 'الحي'}>{property.neighborhood}</SummaryRow>
        ) : null}
        {building?.zoneName ? <SummaryRow label={en ? 'Zone' : 'المنطقة'}>{building.zoneName}</SummaryRow> : null}
        {property.propertyNumber ? (
          <SummaryRow label={en ? 'Parcel no.' : 'رقم العقار'} className="font-mono">
            {property.propertyNumber}
          </SummaryRow>
        ) : null}
        {property.tentLocation ? (
          <SummaryRow label={en ? 'Tent location' : 'موقع الخيمة'}>{property.tentLocation}</SummaryRow>
        ) : null}
        {area ? (
          <SummaryRow label={en ? 'Area' : 'المساحة'} className="font-mono">
            {area} م²
          </SummaryRow>
        ) : null}
        {property.landType ? (
          <SummaryRow label={en ? 'Land type' : 'نوع الأرض'}>{labelOf(labels.landType, property.landType)}</SummaryRow>
        ) : null}
        {property.shares != null ? (
          <SummaryRow label={en ? 'Shares' : 'الأسهم'} className="font-mono">
            {property.shares} / 2400 ({Math.round((property.shares / 2400) * 100)}%)
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
                <StatusLine status={property.unitStatus} labels={labels} />
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
        {!owner && property.landlordPhone ? (
          <SummaryRow label={en ? 'Landlord phone' : 'هاتف المالك'} className="font-mono">
            <bdi dir="ltr">{property.landlordPhone}</bdi>
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
      </Panel>

      {/* ── The building it stands in, from the census ───────────── */}
      {hasBuilding ? (
        <Panel active={tab === 'building'}>
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
        </Panel>
      ) : null}

      {/* ── The units: one table each, picked from the drawing ───── */}
      {units.map((unit, at) => (
        <Panel key={unit.id} active={tab === 'units' && at === index}>
          <UnitRows unit={unit} labels={labels} en={en} tone={tone} />
        </Panel>
      ))}
      </div>

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

      {property.buildingId || actions.length > 0 ? (
        <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2.5">
          <div className="flex flex-wrap gap-2">
            {actions.map(({ key, label, icon: Icon }) => (
              <Button key={key} type="button" variant="outline" size="sm" onClick={() => setDialog(key)}>
                <Icon className="size-4" aria-hidden />
                {label}
              </Button>
            ))}
          </div>
          {property.buildingId ? (
            <Link
              href={`${base}/buildings/${encodeURIComponent(property.buildingId)}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <Building2 className="size-3.5" aria-hidden />
              {en ? 'Open in building register' : 'عرض في سجل المباني'}
              <ExternalLink className="size-3 rtl:-scale-x-100" aria-hidden />
            </Link>
          ) : null}
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
      </div>
    </article>
  );
}

const PROPERTY_ICON: Record<string, typeof Building2> = {
  BUILDING: Building2,
  HOUSE: House,
  LAND: LandPlot,
  TENT: Tent,
};

/** Every unit type the census knows, each with its own icon. */
const UNIT_ICON: Record<string, typeof Building2> = {
  APARTMENT: Building,
  INDEPENDENT_HOUSE: House,
  CLINIC: Stethoscope,
  OFFICE: Briefcase,
  SHOP: Store,
  WAREHOUSE: Warehouse,
  GARAGE: Car,
  PILOTIS: Columns3,
  EMPTY_FLOOR: SquareDashed,
};


/** The open tab's panel inside a block — its tab names it, so it carries no heading of its own. */
/*
  One height for every panel, in every block: switching tab or unit never
  moves the page, and blocks side by side line up. What does not fit scrolls
  inside the panel rather than stretching it.
*/
/**
 * One tab's table. Inactive panels stay laid out but invisible — hidden from
 * sight, focus and screen readers alike — so they still hold the block open
 * to the tallest of them.
 */
function Panel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      aria-hidden={!active}
      className={cn('rounded-xl border px-3 [grid-area:1/1]', !active && 'invisible')}
    >
      <SummaryList>{children}</SummaryList>
    </div>
  );
}

function StatusLine({ status, labels }: { status: string | null | undefined; labels: Labels }) {
  const dot = occupancyDot(status);
  const text = labelOf(labels.unitStatus, status);
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          'size-2.5 shrink-0 rounded-full',
          dot === 'occupied' && 'bg-success',
          dot === 'vacant' && 'bg-muted-foreground/50',
          dot === 'seasonal' && 'border-2 border-success',
        )}
      />
      {text}
    </span>
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
}: {
  unit: CitizenProfileUnit;
  labels: Labels;
  en: boolean;
  tone: PropertyTone;
}) {
  const Icon = (unit.unitType && UNIT_ICON[unit.unitType]) || Building;
  const status = unit.censusUnitStatus ?? unit.unitStatus;
  const disagree = Boolean(unit.censusUnitStatus && unit.unitStatus && unit.censusUnitStatus !== unit.unitStatus);
  const owners = unit.owners ?? [];

  return (
    <>
        <SummaryRow label={en ? 'Unit' : 'الوحدة'} className="font-mono">
          <bdi dir="ltr">{unit.unitCode ?? unit.unitPostedNumber ?? '—'}</bdi>
        </SummaryRow>
        <SummaryRow label={en ? 'Unit type' : 'نوع الوحدة'}>
          <span className="inline-flex items-center gap-1.5">
            <Icon className={cn('size-4', tone === 'owner' ? 'text-success' : 'text-info')} aria-hidden />
            {labelOf(labels.unitType, unit.unitType) ?? (en ? 'Unit' : 'وحدة')}
          </span>
        </SummaryRow>
        {unit.unitPostedNumber && unit.unitCode ? (
          <SummaryRow label={en ? 'Number on door' : 'الرقم على الباب'} className="font-mono">
            <bdi dir="ltr">{unit.unitPostedNumber}</bdi>
          </SummaryRow>
        ) : null}
        {unit.floor ? <SummaryRow label={en ? 'Floor' : 'الطابق'}>{floorText(unit.floor, en)}</SummaryRow> : null}
        {unit.side ? <SummaryRow label={en ? 'Side' : 'الجهة'}>{unit.side}</SummaryRow> : null}
        {unit.unitArea ? (
          <SummaryRow label={en ? 'Area' : 'المساحة'} className="font-mono">
            {unit.unitArea} م²
          </SummaryRow>
        ) : null}
        {status ? (
          <SummaryRow label={disagree ? (en ? 'Status (register)' : 'الحالة في السجل') : en ? 'Status' : 'حالة الوحدة'}>
            <StatusLine status={status} labels={labels} />
          </SummaryRow>
        ) : null}
        {disagree ? (
          <SummaryRow label={en ? 'Status (card)' : 'الحالة على البطاقة'} className="text-warning">
            <StatusLine status={unit.unitStatus} labels={labels} />
          </SummaryRow>
        ) : null}
        {unit.vacancy ? (
          <SummaryRow label={en ? 'Vacancy' : 'الشغور'}>{en ? 'Confirmed' : 'مؤكَّد'}</SummaryRow>
        ) : null}
        {owners.length > 0 ? (
          <SummaryRow label={owners.length > 1 ? (en ? 'Co-owners' : 'المالكون') : en ? 'Owner' : 'المالك'}>
            <span className="flex flex-col items-end gap-0.5">
              {owners.map((person) => (
                <span key={`${person.citizenId ?? person.name}`}>
                  {person.name}
                  {person.shares != null ? (
                    <span className="ms-1 font-mono text-xs text-muted-foreground">({person.shares})</span>
                  ) : null}
                </span>
              ))}
            </span>
          </SummaryRow>
        ) : null}
        {unit.sharedRights.length > 0 ? (
          <SummaryRow label={en ? 'Shared rights' : 'الحقوق المشتركة'}>{unit.sharedRights.join('، ')}</SummaryRow>
        ) : null}
        {unit.presenceMonths && unit.presenceMonths.length > 0 ? (
          <SummaryRow label={en ? 'Present in months' : 'أشهر الحضور'}>{unit.presenceMonths.join('، ')}</SummaryRow>
        ) : null}
        {unit.ownerLastStayAt ? (
          <SummaryRow label={en ? 'Last stay' : 'آخر إقامة'}>{formatDate(unit.ownerLastStayAt)}</SummaryRow>
        ) : null}
        {unit.endedAt ? (
          <SummaryRow label={en ? 'Ended on' : 'تاريخ الانتهاء'}>{formatDate(unit.endedAt)}</SummaryRow>
        ) : null}
    </>
  );
}


/** A card's floor as it is spoken: «0» is the ground floor. */
function floorText(floor: string, en: boolean): string {
  if (floor.trim() === '0') return en ? 'Ground' : 'الأرضي';
  return floor;
}

/** The roles that edit a citizen's file, and so may end a card or unlink its landlord. */
const EDIT_ROLES = ['SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER'];
