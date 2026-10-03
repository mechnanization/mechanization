'use client';

import { Fragment, use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  Building,
  Building2,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  DoorOpen,
  FileText,
  House,
  KeyRound,
  Loader2,
  ShieldX,
  UserRound,
} from 'lucide-react';
import { getLabels, type CitizenResidence } from '@mechanization/shared-schemas';
import { askableFields, type CitizenFormValues } from '@/components/admin/citizen-form';
import {
  OpenQuestionList,
  RecordCompletionEmpty,
  RecordCompletionNotices,
  RecordCompletionSummary,
  displayValue,
  saveLabel,
  useRecordCompletion,
  type OpenItem,
  type RecordCompletion,
} from '@/components/admin/complete-record-dialog';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { StatItem } from '@/components/ui/stat-strip';
import { cn } from '@/lib/utils';
import {
  PropertyScene,
  type ElevationBuilding,
  type PropertyTone,
} from '@/components/admin/property-illustrations';
import {
  CardPanel,
  CardPanels,
  PROPERTY_ICON,
  PropertyCardFrame,
  UNIT_ICON,
  UnitStatusLine,
} from '@/components/admin/property-card-frame';
import { BuildingCensusSummary } from '@/components/admin/building-census-summary';
import { controlFor } from '@/lib/citizen-field-controls';
import { formatDate } from '@/lib/dates';
import { flagFieldLabel } from '@/lib/field-flags';
import { formatPhone } from '@/lib/phone';
import { CITIZEN_RECORD_EDIT_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffSession } from '@/lib/use-staff-session';
import type { CitizenFormData } from '@/lib/api-client';

/** A form value as display text, or null when it holds nothing. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}


type PropertyRef = NonNullable<CitizenFormData['propertyRefs']>[number];

/**
 * «محلول» / «غير محلول» — whether the questions here still hold the record in
 * the queue, as of what has been typed in this sitting (`stillOpen`, the
 * rule the save summary counts by). «محلول» says the save will close it; it
 * never claims the record is closed before it is saved. A word and an icon,
 * not colour alone (COL-3).
 */
function SolvedBadge({ open, locale, size = 'sm' }: { open: number; locale: string; size?: 'sm' | 'lg' }) {
  const en = locale === 'en';
  const solved = open === 0;
  const Icon = solved ? CircleCheck : CircleAlert;
  return (
    <Badge
      variant={solved ? 'soft-success' : 'soft-warning'}
      className={cn('gap-1.5 tabular-nums', size === 'lg' && 'h-9 px-3 text-sm')}
    >
      <Icon className={size === 'lg' ? 'size-4' : 'size-3'} aria-hidden />
      {solved
        ? size === 'lg'
          ? en
            ? 'Solved — save to close'
            : 'محلول — احفظ لإغلاقه'
          : en
            ? 'Solved'
            : 'محلول'
        : en
          ? `Unsolved · ${open} open`
          : `غير محلول · ${open} مفتوح`}
    </Badge>
  );
}

/**
 * One property under review, as the citizen's properties page shows it
 * (`PropertyCardFrame`, UX-1): the drawing in its side panel with this
 * citizen's unit lit, the title and figures, and a switch between
 *
 *  - «الوحدات» — each flat on the card, its census code, type, floor, side,
 *    area and status;
 *  - «العقار» — what the card says, from the form's own list
 *    (`askableFields`, plus the building name a linked card carries);
 *  - «المبنى» — what the census says (`BuildingCensusSummary`).
 *
 * An open field is answered in its own row, where its value would be: the
 * label, «غير مؤكَّد» and the officer's reason at the start, the box at the
 * end (`OpenQuestion` `row`) — said once, not as a row and then again as a
 * block. Every panel keeps the tallest one's height, so switching tab never
 * changes the card's size; the card opens on the tab that holds the open
 * field, and turns to the one a refused save points at.
 */
function ReviewPropertyCard({
  values,
  index,
  items,
  census,
  state,
  base,
  citizenId,
  locale,
  jumpTo,
}: {
  values: CitizenFormValues;
  index: number;
  /** This card's open questions. */
  items: OpenItem[];
  /** The field «الحقل التالي» is taking the clerk to — its tab is opened if it is here. */
  jumpTo: { path: string; at: number } | null;
  /** This card's census codes and building, from `propertyRefs`. */
  census: PropertyRef | undefined;
  state: RecordCompletion;
  base: string;
  citizenId: string;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const fieldLabels = labels.citizenField as Record<string, string>;
  const card = values.properties[index];
  const prefix = `properties.${index}.`;
  const open = new Set(items.map((item) => item.path));
  const leafLabel = (path: string) => {
    const leaf = path.split('.').at(-1) ?? '';
    return fieldLabels[leaf] ?? flagFieldLabel(path, locale);
  };
  const owner = card?.occupancyType === 'OWNER';
  const tone: PropertyTone = owner ? 'owner' : 'occupant';

  // The card's own facts: the form's list, the census-held building name first when there is one.
  const fields = askableFields(values).filter(
    (field) => field.path.startsWith(prefix) && field.path.split('.').length === 3,
  );
  if (!fields.some((field) => field.field === 'buildingName') && displayValue(values, `${prefix}buildingName`, locale)) {
    fields.unshift({ path: `${prefix}buildingName`, field: 'buildingName', section: 'properties', propertyIndex: index });
  }
  const detailFields = fields.filter((field) => !['propertyNumber', 'units'].includes(field.field));
  const shown = detailFields.filter((field) => open.has(field.path) || displayValue(values, field.path, locale));
  const blank = detailFields.filter((field) => !open.has(field.path) && !displayValue(values, field.path, locale));

  const propertyNumber = displayValue(values, `${prefix}propertyNumber`, locale);
  const numberOpen = open.has(`${prefix}propertyNumber`);
  const units = card?.units ?? [];
  const censusUnits = census?.building?.units ?? [];
  const unitCodeAt = (unitIndex: number) =>
    census?.units.find((entry) => entry.id === units[unitIndex]?.id)?.unitCode ?? null;

  /*
    This citizen's census units, lit in the drawing — the flats on this card
    that the census links. A card with no flat lines (a house) on a building
    of exactly one unit is that unit.
  */
  const lit = new Set((census?.units ?? []).map((unit) => unit.unitId).filter((id): id is string => Boolean(id)));
  if (lit.size === 0 && units.length === 0 && censusUnits.length === 1) lit.add(censusUnits[0]!.id);
  const litUnits = censusUnits.filter((unit) => lit.has(unit.id));
  const soleType =
    (units.length === 1 ? units[0]!.unitType : null) ??
    (litUnits.length === 1 ? litUnits[0]!.unitType : null) ??
    (censusUnits.length === 1 ? censusUnits[0]!.unitType : null);
  const manyUnits = censusUnits.length > 1;

  const typeText = card?.propertyType ? labels.propertyType[card.propertyType] : null;
  const roleText = card?.occupancyType ? labels.occupancyType[card.occupancyType] : null;
  const TypeIcon = manyUnits
    ? Building2
    : soleType
      ? (UNIT_ICON[soleType] ?? House)
      : (PROPERTY_ICON[card?.propertyType ?? ''] ?? Building2);
  const title =
    displayValue(values, `${prefix}buildingName`, locale) ||
    (propertyNumber ? (en ? `Parcel ${propertyNumber}` : `عقار رقم ${propertyNumber}`) : typeText) ||
    (en ? `Property ${index + 1}` : `العقار ${index + 1}`);
  const neighbourhood = displayValue(values, `${prefix}neighborhood`, locale);
  const zoneName = census?.building?.zoneName ?? null;
  const zone = zoneName && zoneName !== neighbourhood ? zoneName : null;
  const area =
    displayValue(values, `${prefix}unitArea`, locale) ??
    (units.length
      ? units.reduce((sum, unit) => sum + (Number(unit.unitArea) || 0), 0) || null
      : null);

  const unitItems = items.filter((item) => item.path.split('.').length === 5);
  const cardItems = items.filter((item) => item.path.split('.').length === 3);
  const tabs = [
    ...(units.length > 0
      ? [{ value: 'units', label: en ? `Units (${units.length})` : `الوحدات (${units.length})` }]
      : []),
    { value: 'property', label: en ? 'Property' : 'العقار' },
    ...(census?.building ? [{ value: 'building', label: en ? 'Building' : 'المبنى' }] : []),
  ];
  // Open where the open field is.
  const tabOf = (path: string) => (path.split('.').length === 5 ? 'units' : 'property');
  const [tab, setTab] = useState(unitItems.length > 0 && cardItems.length === 0 ? 'units' : 'property');
  /*
    A closed panel is invisible, so a refused answer in one would be out of
    sight: the card turns to the tab holding the first field the save
    refused, where the focus is about to land.
  */
  const firstRefused = items.find((item) => item.path in state.fieldErrors)?.path ?? null;
  useEffect(() => {
    if (firstRefused) setTab(tabOf(firstRefused));
  }, [firstRefused]);
  useEffect(() => {
    if (jumpTo && items.some((item) => item.path === jumpTo.path)) setTab(tabOf(jumpTo.path));
    // `at` is in the key so a second jump to the same field still opens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.path, jumpTo?.at]);

  /** An open field, answered in its own row of the read-back. */
  const answerRow = (path: string, label: string) => {
    const item = items.find((entry) => entry.path === path);
    if (!item) return null;
    return (
      <OpenQuestionList
        key={path}
        state={state}
        items={[item]}
        base={base}
        citizenId={citizenId}
        locale={locale}
        variant="row"
        labelFor={() => label}
      />
    );
  };
  const placed = new Set<string>();

  const unitValue = (unitIndex: number, field: string) => {
    const path = `${prefix}units.${unitIndex}.${field}`;
    const value = displayValue(values, path, locale);
    if (!value) return <span className="font-normal text-muted-foreground">—</span>;
    if (field === 'unitArea') return <span className="tabular-nums">{en ? `${value} m²` : `${value} م²`}</span>;
    if (field === 'unitStatus') return <UnitStatusLine status={readRaw(values, path)} locale={locale} />;
    return value;
  };

  return (
    <PropertyCardFrame
      picture={
        <PropertyScene
          propertyType={card?.propertyType}
          building={census?.building as ElevationBuilding | null | undefined}
          highlight={lit}
          tone={tone}
          soleType={soleType}
          locale={locale}
        />
      }
      badgeStart={
        <Badge variant={owner ? 'soft-success' : 'soft-info'} className="backdrop-blur">
          {owner ? <KeyRound className="size-3" aria-hidden /> : <DoorOpen className="size-3" aria-hidden />}
          {roleText}
        </Badge>
      }
      badgesEnd={<SolvedBadge open={items.filter(state.stillOpen).length} locale={locale} />}
      icon={TypeIcon}
      tone={tone}
      title={title}
      neighbourhood={neighbourhood}
      zone={zone}
      stats={
        units.length > 0 || census?.building || area ? (
          <>
            {units.length > 0 ? (
              <StatItem
                value={units.length}
                label={owner ? (en ? 'Units owned' : 'وحدات يملكها') : en ? 'Units' : 'وحدات'}
                className={owner ? 'text-success' : 'text-info'}
              />
            ) : null}
            {census?.building ? (
              <StatItem value={census.building.floorsCount} label={en ? 'Floors' : 'طوابق'} />
            ) : null}
            {census?.building && census.building.unitsTotal > 1 ? (
              <StatItem value={census.building.unitsTotal} label={en ? 'Units in building' : 'وحدات المبنى'} />
            ) : null}
            {area ? <StatItem value={area} unit={en ? 'm²' : 'م²'} label={en ? 'Area' : 'المساحة'} /> : null}
          </>
        ) : null
      }
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      locale={locale}
    >
      <CardPanels>
        {units.length > 0 ? (
          <CardPanel active={tab === 'units'}>
            {units.map((unit, unitIndex) => {
              const UnitIcon = (unit.unitType && UNIT_ICON[unit.unitType]) || Building;
              const code = unitCodeAt(unitIndex);
              const fact = (field: string, label: string, value: React.ReactNode) => {
                const path = `${prefix}units.${unitIndex}.${field}`;
                if (open.has(path)) {
                  placed.add(path);
                  return answerRow(path, label);
                }
                return <SummaryRow key={path} label={label}>{value}</SummaryRow>;
              };
              return (
                <Fragment key={unit.id ?? unitIndex}>
                  <SummaryRow label={en ? 'Unit' : 'الوحدة'} className="font-mono">
                    {code ?? (en ? `Unit ${unitIndex + 1}` : `الوحدة ${unitIndex + 1}`)}
                  </SummaryRow>
                  {fact(
                    'unitType',
                    en ? 'Unit type' : 'نوع الوحدة',
                    <span className="inline-flex items-center gap-1.5">
                      <UnitIcon className={cn('size-4', owner ? 'text-success' : 'text-info')} aria-hidden />
                      {unitValue(unitIndex, 'unitType')}
                    </span>,
                  )}
                  {fact('floor', leafLabel('floor'), unitValue(unitIndex, 'floor'))}
                  {fact('side', leafLabel('side'), unitValue(unitIndex, 'side'))}
                  {fact('unitArea', leafLabel('unitArea'), unitValue(unitIndex, 'unitArea'))}
                  {fact('unitStatus', leafLabel('unitStatus'), unitValue(unitIndex, 'unitStatus'))}
                </Fragment>
              );
            })}
          </CardPanel>
        ) : null}

        <CardPanel active={tab === 'property'}>
          <SummaryRow label={en ? 'Property type' : 'نوع العقار'}>{typeText ?? '—'}</SummaryRow>
          <SummaryRow label={en ? 'Standing' : 'صفة الإشغال'}>{roleText ?? '—'}</SummaryRow>
          {numberOpen ? (
            (placed.add(`${prefix}propertyNumber`), answerRow(`${prefix}propertyNumber`, labels.citizenField.propertyNumber))
          ) : (
            <SummaryRow label={labels.citizenField.propertyNumber} className="font-mono">
              {propertyNumber ?? '—'}
            </SummaryRow>
          )}
          {shown.map((field) => {
            if (open.has(field.path)) {
              placed.add(field.path);
              return answerRow(field.path, leafLabel(field.path));
            }
            const value = displayValue(values, field.path, locale) ?? '';
            const kind = controlFor(field.path).kind;
            return (
              <SummaryRow
                key={field.path}
                label={leafLabel(field.path)}
                className={kind === 'number' || kind === 'phone' ? 'tabular-nums' : undefined}
              >
                {field.field === 'unitStatus' ? (
                  <UnitStatusLine status={readRaw(values, field.path)} locale={locale} />
                ) : kind === 'phone' ? (
                  formatPhone(value)
                ) : (
                  value
                )}
              </SummaryRow>
            );
          })}
        </CardPanel>

        {census?.building ? (
          <CardPanel active={tab === 'building'}>
            <BuildingCensusSummary building={census.building} code={census.buildingCode} bare locale={locale} />
          </CardPanel>
        ) : null}
      </CardPanels>

      {/*
        What no row holds — a flag on a whole list of flats, «سجل مشابه» — and
        the fields simply left blank, named once.
      */}
      <div className="mx-4 mb-4 space-y-3 empty:hidden">
        {(() => {
          const rest = items.filter((item) => !placed.has(item.path));
          return rest.length > 0 ? (
            <OpenQuestionList
              state={state}
              items={rest}
              base={base}
              citizenId={citizenId}
              locale={locale}
              variant="inline"
              labelFor={(item) => leafLabel(item.path)}
            />
          ) : null;
        })()}
        {blank.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {en ? 'Left blank: ' : 'تُركت فارغة: '}
            {blank.map((field) => leafLabel(field.path)).join(en ? ', ' : '، ')}
          </p>
        ) : null}
      </div>
    </PropertyCardFrame>
  );
}

/** The stored code at a path (an enum's value, not its label) — for a status dot. */
function readRaw(values: CitizenFormValues, path: string): string | null {
  const parts = path.split('.');
  const card = values.properties[Number(parts[1])] as unknown as Record<string, unknown> | undefined;
  const holder =
    parts.length === 5
      ? ((card?.units as Array<Record<string, unknown>> | undefined)?.[Number(parts[3])] ?? undefined)
      : card;
  const value = holder?.[parts.at(-1) ?? ''];
  return typeof value === 'string' && value ? value : null;
}

/**
 * «فحص الملف» — one record from «يتطلب مراجعة», laid out in the order a
 * reviewer reads a file:
 *
 *  1. **The citizen**, always first: who this is and how to reach them, with
 *     any open personal or contact field highlighted in the same card.
 *  2. **One card per property that has an open field** (`ReviewPropertyCard`,
 *     the properties page's own card): the drawing, the units, the property
 *     and the building in their tabs, the open fields marked in them, and
 *     the boxes to answer them under the panels.
 *
 * A record with nothing left to answer is not a dead end: it says why, and
 * «إغلاق المراجعة» saves it as it is (`closesReview`).
 *
 * The questions, their rules and the save are `useRecordCompletion` — the
 * same as the «استكمال البيانات الناقصة» dialog on the citizen's file. The
 * save validates with the server's own schema first, marks the rows it
 * refuses and focuses the first (FRM-2).
 *
 * The queue is open to every staff role, but the record's form is not
 * (`CITIZEN_RECORD_EDIT_ROLES`, CODE-4): an auditor or an accountant who
 * reaches this page by its URL is told so and pointed at the file they can
 * read, rather than shown a load failure whose retry can only fail again.
 */
export default function ReviewFilePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; citizenId: string }>;
}) {
  const { tenant, locale, adminPath, citizenId } = use(params);
  const en = locale === 'en';
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  /** Null until the session has been read — both arrive in the same effect. */
  const permitted = user ? hasRole(CITIZEN_RECORD_EDIT_ROLES, user.role) : null;

  const state = useRecordCompletion({
    /*
      Not before the session is read: until then `token` is null, which the
      hook takes for a lapsed session (`enabled`). A missing session never
      gets here — `useStaffSession` sends it to the login page.
    */
    enabled: Boolean(token) && permitted === true,
    tenant,
    token,
    citizenId,
    locale,
    onSaved: (stillOpen) => {
      // The register and the queue both count this record.
      void queryClient.invalidateQueries({ queryKey: ['citizens'] });
      // Finished: back to the queue for the next one. Not yet: read the file again for its new version.
      if (stillOpen === 0) router.push(`${base}/citizens/review`);
      else state.reload();
    },
  });
  const { values, record, items, saving, loadError } = state;

  /*
    The questions, by what they are about. A path names its section:
    `personal.*` and `contact.*` are the citizen's own (with the record-level
    «سجل مشابه»), `properties.<n>.*` — units included — are that property's.
  */
  const { personalItems, propertySections } = useMemo(() => {
    const personal: OpenItem[] = [];
    const byCard = new Map<number, OpenItem[]>();
    for (const item of items) {
      const [head, index] = item.path.split('.');
      if (head === 'properties') {
        const card = Number(index);
        byCard.set(card, [...(byCard.get(card) ?? []), item]);
      } else {
        personal.push(item);
      }
    }
    return {
      personalItems: personal,
      propertySections: [...byCard.entries()].sort(([a], [b]) => a - b),
    };
  }, [items]);

  /*
    «الحقل التالي» — on a file with many open fields, the next one still
    without an answer, after the one the cursor is in (wrapping round), in the
    order the page shows them: the citizen's, then each property's. Its card
    opens the tab it sits in (`jumpTo`), then the box is scrolled to and
    focused — once that tab has been drawn, hence the frame's wait.
  */
  const [jump, setJump] = useState<{ path: string; at: number } | null>(null);
  const ordered = [...personalItems, ...propertySections.flatMap(([, sectionItems]) => sectionItems)];
  const nextOpen = () => {
    const open = ordered.filter((item) => state.stillOpen(item) && item.answerable);
    if (open.length === 0) return;
    const here = typeof document !== 'undefined' ? document.activeElement?.id ?? '' : '';
    const at = ordered.findIndex((item) => here.startsWith(`complete-${item.path.replace(/\./g, '-')}`));
    const next = open.find((item) => ordered.indexOf(item) > at) ?? open[0]!;
    setJump({ path: next.path, at: Date.now() });
  };
  useEffect(() => {
    if (!jump) return;
    const id = `complete-${jump.path.replace(/\./g, '-')}`;
    const timer = window.setTimeout(() => {
      const input = document.getElementById(id);
      // Instant under reduced motion (MOT-6).
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      input?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      input?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [jump]);

  const personal = values?.personal ?? {};
  const contact = values?.contact ?? {};
  const fullName =
    [text(personal.firstName), text(personal.middleName), text(personal.lastName)].filter(Boolean).join(' ') ||
    (en ? 'Unnamed' : 'بلا اسم');
  const phone = text(contact.phone);
  const residence = values?.residence as CitizenResidence | undefined;
  const dash = <span className="text-muted-foreground">—</span>;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink
        fallbackHref={`${base}/citizens/review`}
        label={en ? 'Back to the review queue' : 'العودة إلى قائمة المراجعة'}
      />
      {/*
        Who first: the page is about one person, so their name is the heading
        and «فحص الملف» with their الرقم المرجعي sits under it. The record's
        status stands beside the way to the full file — on a phone, the two
        share a row under the title while they fit, and the button wraps to a
        full-width line of its own when the status grows («محلول — احفظ لإغلاقه»).
        Announced as it changes (A11Y-5): it flips while the clerk types.
      */}
      <PageHeader
        icon={ClipboardCheck}
        title={values ? fullName : en ? 'Review file' : 'فحص الملف'}
        subtitle={
          values ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{en ? 'Review file' : 'فحص الملف'}</span>
              {record?.citizenReferenceNumber ? (
                <>
                  <span aria-hidden>·</span>
                  <bdi className="font-mono">{record.citizenReferenceNumber}</bdi>
                </>
              ) : null}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
            {values ? (
              <span role="status" aria-live="polite" className="shrink-0">
                <SolvedBadge open={state.remaining} locale={locale} size="lg" />
              </span>
            ) : null}
            {/* A role that cannot review has the same link as the way out of the state below. */}
            {permitted === false ? null : (
              <Link
                href={`${base}/citizens/${citizenId}`}
                className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 basis-40 sm:flex-none sm:basis-auto')}
              >
                <FileText className="size-4" aria-hidden />
                {en ? 'Open the full file' : 'فتح الملف الكامل'}
              </Link>
            )}
          </div>
        }
      />

      {permitted === false ? (
        <Card>
          <CardContent className="p-4">
            <EmptyState
              icon={ShieldX}
              title={en ? 'Your role cannot review files' : 'فحص الملفات غير متاح لدورك'}
              description={
                en
                  ? "Reviewing a file completes the citizen's record, which your role is not permitted to change. You can still read the full file."
                  : 'فحص الملف يستكمل سجل المواطن، ودورك لا يملك صلاحية تعديله. يمكنك قراءة الملف كاملاً.'
              }
              action={
                <Link href={`${base}/citizens/${citizenId}`} className={buttonVariants({ variant: 'outline' })}>
                  <FileText className="size-4" aria-hidden />
                  {en ? 'Open the full file' : 'فتح الملف الكامل'}
                </Link>
              }
            />
          </CardContent>
        </Card>
      ) : loadError ? (
        <ErrorState
          title={loadError}
          onRetry={state.reload}
          retryLabel={en ? 'Try again' : 'إعادة المحاولة'}
        />
      ) : !values ? (
        <Card>
          <CardContent className="p-4">
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 1 — The citizen, always first, with their own open fields. */}
          <Card>
            <CardHeader className="border-b px-4 py-3.5">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
                <UserRound className="size-5 text-primary" aria-hidden />
                <h2>{en ? 'Personal information' : 'البيانات الشخصية'}</h2>
                {personalItems.length > 0 ? (
                  <SolvedBadge open={personalItems.filter(state.stillOpen).length} locale={locale} />
                ) : (
                  <Badge variant="soft-success">{en ? 'Complete' : 'مكتملة'}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            {/* One column, full width: the facts, then the open fields answered in place. */}
            <CardContent className="p-4">
              <div className="space-y-4">
              <SummaryList>
                <SummaryRow label={en ? 'Full name' : 'الاسم الكامل'}>{fullName}</SummaryRow>
                <SummaryRow label={en ? "Mother's name" : 'اسم الأم وشهرتها'}>
                  {text(personal.motherName) ?? dash}
                </SummaryRow>
                <SummaryRow label={en ? 'Reference no.' : 'الرقم المرجعي'} className="font-mono">
                  {record?.citizenReferenceNumber ?? dash}
                </SummaryRow>
                <SummaryRow label={en ? 'Phone' : 'الهاتف'}>
                  {phone ? (
                    <a href={`tel:${phone}`} dir="ltr" className="tabular-nums text-primary underline-offset-2 hover:underline">
                      {formatPhone(phone)}
                    </a>
                  ) : (
                    dash
                  )}
                </SummaryRow>
                <SummaryRow label={en ? 'File type' : 'نوع الملف'}>
                  {labels.citizenResidence[residence ?? 'RESIDENT']}
                </SummaryRow>
                {record?.lastStaffEdit ? (
                  <SummaryRow label={en ? 'Last changed' : 'آخر تعديل'}>
                    <span className="tabular-nums">{formatDate(record.lastStaffEdit.at)}</span>
                    {record.lastStaffEdit.name ? ` · ${record.lastStaffEdit.name}` : null}
                  </SummaryRow>
                ) : null}
                {/* The open fields as rows of the same read-back, as on the property cards. */}
                {personalItems.length > 0 ? (
                  <OpenQuestionList
                    state={state}
                    items={personalItems}
                    base={base}
                    citizenId={citizenId}
                    locale={locale}
                    variant="row"
                  />
                ) : null}
              </SummaryList>
              </div>
            </CardContent>
          </Card>

          {/* 2 — One section per property with an open field: all it holds, and its gaps. */}
          {propertySections.length > 0 ? (
            <section className="space-y-3" aria-labelledby="review-properties">
              <h2 id="review-properties" className="flex items-center gap-2 text-base font-semibold">
                <Building2 className="size-5 text-primary" aria-hidden />
                {en ? 'Properties' : 'العقارات'}
                <span className="text-sm font-normal tabular-nums text-muted-foreground">
                  ({propertySections.length})
                </span>
              </h2>
              {propertySections.map(([index, sectionItems]) => {
                const card = values.properties[index];
                return (
                  <ReviewPropertyCard
                    key={index}
                    values={values}
                    index={index}
                    items={sectionItems}
                    census={record?.propertyRefs?.find((entry) => entry.propertyId === card?.id)}
                    state={state}
                    base={base}
                    citizenId={citizenId}
                    locale={locale}
                    jumpTo={jump}
                  />
                );
              })}
            </section>
          ) : null}

          {/* A record in the queue with nothing to answer: said, with the way out. */}
          {items.length === 0 ? (
            <Card>
              <CardContent className="p-4">
                <RecordCompletionEmpty state={state} locale={locale} />
              </CardContent>
            </Card>
          ) : null}

          {/* The save, kept in reach however long the file is. */}
          {state.canSave || state.saveError || state.blockedElsewhere.length > 0 ? (
            <div className="sticky bottom-0 z-10 -mx-4 space-y-3 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
              <RecordCompletionNotices state={state} base={base} citizenId={citizenId} locale={locale} />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <RecordCompletionSummary state={state} locale={locale} />
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                {state.remaining > 0 ? (
                  <Button type="button" variant="outline" className="flex-1 gap-1.5 sm:flex-none" onClick={nextOpen}>
                    <ArrowDownToLine className="size-4" aria-hidden />
                    {en ? `Next field (${state.remaining} left)` : `الحقل التالي (${state.remaining} متبقٍ)`}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  className="flex-1 gap-1.5 sm:flex-none"
                  disabled={saving || !state.canSave}
                  onClick={() => void state.save()}
                >
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Check className="size-4" aria-hidden />
                  )}
                  {saveLabel(state, en)}
                </Button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
