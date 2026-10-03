'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Check, ClipboardCheck, FileText, Loader2, UserRound } from 'lucide-react';
import { getLabels, type CitizenResidence } from '@mechanization/shared-schemas';
import type { ColumnDef } from '@tanstack/react-table';
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
import { CellTag } from '@/components/ui/cell-tag';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { PropertyScene, type ElevationBuilding } from '@/components/admin/property-illustrations';
import { BuildingCensusSummary } from '@/components/admin/building-census-summary';
import { controlFor } from '@/lib/citizen-field-controls';
import { formatDate } from '@/lib/dates';
import { flagFieldLabel } from '@/lib/field-flags';
import { formatPhone } from '@/lib/phone';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import type { CitizenFormData } from '@/lib/api-client';

/** A form value as display text, or null when it holds nothing. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Up to this many property sections open on arrival; past it, only the first. */
const OPEN_SECTIONS_LIMIT = 2;

type PropertyRef = NonNullable<CitizenFormData['propertyRefs']>[number];

/** A unit of a مبنى card as the table reads it. */
interface UnitRow {
  id: string;
  index: number;
  code: string | null;
}

/**
 * One property card as a read-back, top to bottom (`SummaryList`: the one
 * record this screen is about — PRIM-7):
 *
 *  1. **Identifiers**: the census building code and the card's رقم العقار.
 *  2. **The filled details**, from the form's own list (`askableFields`,
 *     plus the building name a linked card carries), each read through its
 *     control. Values are text — no chips in a read-back.
 *     Beside them, the property drawn with this citizen's unit lit; under
 *     them, for a linked card, the building's census summary
 *     (`BuildingCensusSummary`, the unit matrix's own rows).
 *  3. **The open fields, answered in place**: a tinted block per field, with
 *     the officer's reason and the box. An open field is not also listed
 *     above, so nothing on the page is said twice.
 *  4. **The fields simply left blank**, named once in one line rather than a
 *     row of «—» each.
 *  5. **A مبنى's flats**, one row each with its unit code; an open flat
 *     field is marked in its cell (`CellTag`, PRIM-8) and answered below.
 */
function PropertyDetails({
  values,
  index,
  items,
  census,
  state,
  base,
  citizenId,
  locale,
}: {
  values: CitizenFormValues;
  index: number;
  /** This card's open questions. */
  items: OpenItem[];
  /** This card's census codes, from `propertyRefs`. */
  census: PropertyRef | undefined;
  state: RecordCompletion;
  base: string;
  citizenId: string;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const fieldLabels = labels.citizenField as Record<string, string>;
  const tableLabels = useTableLabels();
  const card = values.properties[index];
  const prefix = `properties.${index}.`;
  const open = new Set(items.map((item) => item.path));
  const leafLabel = (path: string) => {
    const leaf = path.split('.').at(-1) ?? '';
    return fieldLabels[leaf] ?? flagFieldLabel(path, locale);
  };

  // The form's list for this card, the census-held building name first when there is one.
  const fields = askableFields(values).filter(
    (field) => field.path.startsWith(prefix) && field.path.split('.').length === 3,
  );
  if (!fields.some((field) => field.field === 'buildingName') && displayValue(values, `${prefix}buildingName`, locale)) {
    fields.unshift({ path: `${prefix}buildingName`, field: 'buildingName', section: 'properties', propertyIndex: index });
  }
  // رقم العقار is an identifier, and the units have their own table.
  const detailFields = fields.filter((field) => !['propertyNumber', 'units'].includes(field.field));
  const filled = detailFields.filter((field) => !open.has(field.path) && displayValue(values, field.path, locale));
  const blank = detailFields.filter((field) => !open.has(field.path) && !displayValue(values, field.path, locale));

  const propertyNumber = displayValue(values, `${prefix}propertyNumber`, locale);
  const units = card?.units ?? [];
  const unitCodeAt = (unitIndex: number) =>
    census?.units.find((entry) => entry.id === units[unitIndex]?.id)?.unitCode ?? null;

  const cardItems = items.filter((item) => item.path.split('.').length === 3);
  const unitItems = items.filter((item) => item.path.split('.').length === 5);

  const unitRows: UnitRow[] = units.map((unit, unitIndex) => ({
    id: unit.id ?? `${index}-${unitIndex}`,
    index: unitIndex,
    code: unitCodeAt(unitIndex),
  }));
  const unitCell = (row: UnitRow, field: string) => {
    const path = `${prefix}units.${row.index}.${field}`;
    if (open.has(path)) return <CellTag tone="warning">{en ? 'Unconfirmed' : 'غير مؤكَّد'}</CellTag>;
    const value = displayValue(values, path, locale);
    if (!value) return <CellTag tone="muted">—</CellTag>;
    if (field === 'unitArea') return <CellTag className="tabular-nums">{en ? `${value} m²` : `${value} م²`}</CellTag>;
    return <CellTag>{value}</CellTag>;
  };
  const unitColumns: ColumnDef<UnitRow>[] = [
    {
      id: 'code',
      header: en ? 'Unit code' : 'رمز الوحدة',
      meta: { mobile: 'primary' },
      cell: ({ row }) =>
        row.original.code ? (
          <CellTag className="font-mono" dir="ltr">{row.original.code}</CellTag>
        ) : (
          <CellTag tone="muted">{en ? 'Not on the census' : 'غير مربوطة بالمسح'}</CellTag>
        ),
    },
    ...(['unitType', 'floor', 'side', 'unitArea', 'unitStatus'] as const).map(
      (field): ColumnDef<UnitRow> => ({
        id: field,
        header: fieldLabels[field] ?? field,
        cell: ({ row }) => unitCell(row.original, field),
      }),
    ),
  ];

  /*
    The picture: the same one the citizen's properties page draws (`PropertyScene`),
    with this citizen's census units lit — the flats on this card that the
    census links. A card linked to no building is drawn as its type.
  */
  const lit = new Set((census?.units ?? []).map((unit) => unit.unitId).filter((id): id is string => Boolean(id)));
  const litCodes = (census?.building?.units ?? []).filter((unit) => lit.has(unit.id)).map((unit) => unit.unitCode);
  const soleType =
    (units.length === 1 ? units[0]!.unitType : null) ??
    (census?.building?.units.filter((unit) => lit.has(unit.id)).length === 1
      ? census.building.units.find((unit) => lit.has(unit.id))!.unitType
      : null) ??
    (census?.building?.units.length === 1 ? census.building.units[0]!.unitType : null);

  return (
    <div className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <SummaryList>
            <SummaryRow
              label={en ? 'Building code' : 'رمز المبنى'}
              className={census?.buildingCode ? 'font-mono' : 'font-normal text-muted-foreground'}
            >
              {census?.buildingCode ?? (en ? 'Not linked to the census' : 'غير مربوط بالمسح')}
            </SummaryRow>
            {open.has(`${prefix}propertyNumber`) ? null : (
              <SummaryRow
                label={labels.citizenField.propertyNumber}
                className={propertyNumber ? 'font-mono' : 'font-normal text-muted-foreground'}
              >
                {propertyNumber ?? '—'}
              </SummaryRow>
            )}
                {filled.map((field) => {
              const value = displayValue(values, field.path, locale) ?? '';
              const kind = controlFor(field.path).kind;
              return (
                <SummaryRow
                  key={field.path}
                  label={leafLabel(field.path)}
                  className={kind === 'number' || kind === 'phone' ? 'tabular-nums' : undefined}
                >
                  {kind === 'phone' ? formatPhone(value) : value}
                </SummaryRow>
              );
            })}
          </SummaryList>
          {census?.building ? (
            <div className="mt-5 space-y-1">
              <h4 className="text-sm font-semibold">{en ? 'The building in the census' : 'المبنى في المسح'}</h4>
              <BuildingCensusSummary building={census.building} locale={locale} />
            </div>
          ) : null}
        </div>
        {/* Where it is: the building drawn, this citizen's unit lit (ICO-2: the list beside it is the record). */}
        <figure className="space-y-2">
          <div className="relative h-64 overflow-hidden rounded-lg border bg-muted/40">
            <div className="absolute inset-x-6 bottom-6 top-8 overflow-hidden">
              <PropertyScene
                propertyType={card?.propertyType}
                building={census?.building as ElevationBuilding | null | undefined}
                highlight={lit}
                tone={card?.occupancyType === 'OWNER' ? 'owner' : 'occupant'}
                soleType={soleType}
                locale={locale}
              />
            </div>
          </div>
          <figcaption className="text-xs text-muted-foreground">
            {census?.building
              ? litCodes.length > 0
                ? en
                  ? `Lit: this citizen's unit ${litCodes.join(', ')}`
                  : `المضاءة: وحدة المواطن ${litCodes.join('، ')}`
                : en
                  ? 'No unit in this building is linked to this card yet.'
                  : 'لا وحدة في هذا المبنى مربوطة بهذه البطاقة بعد.'
              : en
                ? 'Drawn by its type — this card is not linked to a census building.'
                : 'مرسوم بحسب نوعه — هذه البطاقة غير مربوطة بمبنى في المسح.'}
          </figcaption>
        </figure>
      </div>

      {cardItems.length > 0 ? (
        <OpenQuestionList
          state={state}
          items={cardItems}
          base={base}
          citizenId={citizenId}
          locale={locale}
          variant="inline"
          labelFor={(item) => leafLabel(item.path)}
        />
      ) : null}

      {blank.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {en ? 'Left blank: ' : 'تُركت فارغة: '}
          {blank.map((field) => leafLabel(field.path)).join(en ? ', ' : '، ')}
        </p>
      ) : null}

      {unitRows.length > 0 ? (
        <div className="space-y-3 pt-2">
          <h4 className="text-sm font-semibold">
            {labels.citizenField.units}
            <span className="ms-1.5 font-normal tabular-nums text-muted-foreground">({unitRows.length})</span>
          </h4>
          <DataTable
            columns={unitColumns}
            data={unitRows}
            labels={tableLabels}
            getRowId={(row) => row.id}
            searchable={false}
            sortable={false}
            paginated={false}
          />
          {unitItems.length > 0 ? (
            <OpenQuestionList
              state={state}
              items={unitItems}
              base={base}
              citizenId={citizenId}
              locale={locale}
              variant="inline"
              labelFor={(item) => {
                const unitIndex = Number(item.path.split('.')[3]);
                const code = unitCodeAt(unitIndex);
                const unit = code ?? (en ? `unit ${unitIndex + 1}` : `الوحدة ${unitIndex + 1}`);
                return `${leafLabel(item.path)} — ${unit}`;
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * «فحص الملف» — one record from «يتطلب مراجعة», laid out in the order a
 * reviewer reads a file:
 *
 *  1. **The citizen**, always first: who this is and how to reach them, with
 *     any open personal or contact field highlighted in the same card.
 *  2. **One section per property that has an open field**: everything the
 *     form holds about that property, the open fields marked in it, and the
 *     boxes to answer them. Collapsible, so a file with gaps on four
 *     properties does not arrive as one long form; up to
 *     `OPEN_SECTIONS_LIMIT` arrive open.
 *
 * A record with nothing left to answer is not a dead end: it says why, and
 * «إغلاق المراجعة» saves it as it is (`closesReview`).
 *
 * The questions, their rules and the save are `useRecordCompletion` — the
 * same as the «استكمال البيانات الناقصة» dialog on the citizen's file. The
 * save validates with the server's own schema first, marks the rows it
 * refuses and focuses the first (FRM-2).
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
  const { token } = useStaffSession(tenant, base);

  const state = useRecordCompletion({
    enabled: true,
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

  const personal = values?.personal ?? {};
  const contact = values?.contact ?? {};
  const fullName =
    [text(personal.firstName), text(personal.middleName), text(personal.lastName)].filter(Boolean).join(' ') ||
    (en ? 'Unnamed' : 'بلا اسم');
  const phone = text(contact.phone);
  const residence = values?.residence as CitizenResidence | undefined;
  const dash = <span className="text-muted-foreground">—</span>;

  const openCount = (count: number) => (en ? `${count} open` : `${count} مفتوح`);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink
        fallbackHref={`${base}/citizens/review`}
        label={en ? 'Back to the review queue' : 'العودة إلى قائمة المراجعة'}
      />
      <PageHeader
        icon={ClipboardCheck}
        title={en ? 'Review file' : 'فحص الملف'}
        subtitle={values ? fullName : undefined}
        actions={
          <Link href={`${base}/citizens/${citizenId}`} className={buttonVariants({ variant: 'outline' })}>
            <FileText className="size-4" aria-hidden />
            {en ? 'Open the full file' : 'فتح الملف الكامل'}
          </Link>
        }
      />

      {loadError ? (
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
                  <Badge variant="soft-warning" className="tabular-nums">
                    {openCount(personalItems.length)}
                  </Badge>
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
              </SummaryList>

              {personalItems.length > 0 ? (
                <OpenQuestionList
                  state={state}
                  items={personalItems}
                  base={base}
                  citizenId={citizenId}
                  locale={locale}
                  variant="inline"
                />
              ) : null}
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
              {propertySections.map(([index, sectionItems], position) => {
                const card = values.properties[index];
                const type = card?.propertyType ? labels.propertyType[card.propertyType] : null;
                const role = card?.occupancyType ? labels.occupancyType[card.occupancyType] : null;
                const title = [en ? `Property ${index + 1}` : `العقار ${index + 1}`, type, role]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <CollapsibleSection
                    key={index}
                    id={`review-property-${index}`}
                    title={title}
                    icon={Building2}
                    summary={
                      <Badge variant="soft-warning" className="tabular-nums">
                        {openCount(sectionItems.length)}
                      </Badge>
                    }
                    defaultOpen={propertySections.length <= OPEN_SECTIONS_LIMIT || position === 0}
                  >
                    <PropertyDetails
                      values={values}
                      index={index}
                      items={sectionItems}
                      census={record?.propertyRefs?.find((entry) => entry.propertyId === card?.id)}
                      state={state}
                      base={base}
                      citizenId={citizenId}
                      locale={locale}
                    />
                  </CollapsibleSection>
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
                <Button
                  type="button"
                  className="shrink-0 gap-1.5"
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
          ) : null}
        </>
      )}
    </div>
  );
}
