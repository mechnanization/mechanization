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
} from '@/components/admin/complete-record-dialog';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { DataTable } from '@/components/ui/data-table';
import { FactCell, FactRow } from '@/components/ui/facts';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
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
 * Everything one property card holds, laid out to be read rather than
 * scanned for dashes:
 *
 *  - **Identifiers first**, as codes: the census building code, رقم العقار,
 *    and the census parcel when it differs from (or fills in for) the card's
 *    own number — the first thing a reviewer checks an answer against.
 *  - **The details**, from the form's own list (`askableFields`, plus the
 *    building name a linked card carries), each read through its control.
 *    Filled ones as facts in two columns; open ones marked «غير مؤكَّد» in
 *    place; the ones simply left blank folded into one line, so a card with
 *    six empty optional fields is not six rows of «—».
 *  - **The flats** of a مبنى, one row each with its unit code.
 */
function PropertyDetails({
  values,
  index,
  open,
  census,
  locale,
}: {
  values: CitizenFormValues;
  index: number;
  /** The paths still open on this card — marked, never shown as blanks. */
  open: Set<string>;
  /** This card's census codes, from `propertyRefs`. */
  census: PropertyRef | undefined;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const fieldLabels = labels.citizenField as Record<string, string>;
  const card = values.properties[index];
  const tableLabels = useTableLabels();
  const prefix = `properties.${index}.`;
  const labelOf = (path: string, field: string) => fieldLabels[field] ?? flagFieldLabel(path, locale);
  const unconfirmed = <Badge variant="soft-warning">{en ? 'Unconfirmed' : 'غير مؤكَّد'}</Badge>;

  // The form's list for this card, the census-held building name first when there is one.
  const fields = askableFields(values).filter(
    (field) => field.path.startsWith(prefix) && field.path.split('.').length === 3,
  );
  if (!fields.some((field) => field.field === 'buildingName') && displayValue(values, `${prefix}buildingName`, locale)) {
    fields.unshift({ path: `${prefix}buildingName`, field: 'buildingName', section: 'properties', propertyIndex: index });
  }

  // Identifiers are shown above; the units have their own table below.
  const detailFields = fields.filter((field) => !['propertyNumber', 'units'].includes(field.field));
  const filled = detailFields.filter((field) => open.has(field.path) || displayValue(values, field.path, locale));
  const blank = detailFields.filter((field) => !open.has(field.path) && !displayValue(values, field.path, locale));

  const fact = (path: string, field: string) => {
    const value = displayValue(values, path, locale);
    const kind = controlFor(path).kind;
    return (
      <FactCell
        key={path}
        label={labelOf(path, field)}
        className={kind === 'number' || kind === 'phone' ? 'tabular-nums' : undefined}
        value={open.has(path) ? unconfirmed : kind === 'phone' && value ? formatPhone(value) : value}
      />
    );
  };
  const half = Math.ceil(filled.length / 2);

  const propertyNumber = displayValue(values, `${prefix}propertyNumber`, locale);
  const numberOpen = open.has(`${prefix}propertyNumber`);
  const parcel = census?.parcelNumber ?? null;
  const showParcel = Boolean(parcel) && parcel !== propertyNumber;

  const units = card?.units ?? [];
  const unitRows: UnitRow[] = units.map((unit, unitIndex) => ({
    id: unit.id ?? `${index}-${unitIndex}`,
    index: unitIndex,
    code: census?.units.find((entry) => entry.id === unit.id)?.unitCode ?? null,
  }));
  const unitCell = (row: UnitRow, field: string) => {
    const path = `${prefix}units.${row.index}.${field}`;
    if (open.has(path)) return unconfirmed;
    const value = displayValue(values, path, locale);
    if (!value) return <span className="text-muted-foreground">—</span>;
    if (field === 'unitArea') return <span className="tabular-nums">{en ? `${value} m²` : `${value} م²`}</span>;
    return <bdi>{value}</bdi>;
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

  return (
    <div className="space-y-5">
      {/* Identifiers — what the property is known by, as codes. */}
      <dl className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg bg-muted/40 px-4 py-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{en ? 'Building code' : 'رمز المبنى'}</dt>
          <dd className="mt-0.5 text-sm font-semibold">
            {census?.buildingCode ? (
              <bdi className="font-mono">{census.buildingCode}</bdi>
            ) : (
              <span className="font-normal text-muted-foreground">
                {en ? 'Not linked to the census' : 'غير مربوط بالمسح'}
              </span>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{labels.citizenField.propertyNumber}</dt>
          <dd className="mt-0.5 text-sm font-semibold">
            {numberOpen ? (
              unconfirmed
            ) : propertyNumber ? (
              <bdi className="font-mono">{propertyNumber}</bdi>
            ) : (
              <span className="font-normal text-muted-foreground">—</span>
            )}
          </dd>
        </div>
        {showParcel ? (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {en ? 'Property no. in the census' : 'رقم العقار في المسح'}
            </dt>
            <dd className="mt-0.5 text-sm font-semibold">
              <bdi className="font-mono">{parcel}</bdi>
            </dd>
          </div>
        ) : null}
        {units.length > 0 ? (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{labels.citizenField.units}</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums">{units.length}</dd>
          </div>
        ) : null}
      </dl>

      {/* The details: filled and open as facts, the blank ones named once. */}
      {filled.length > 0 ? (
        <div className="grid gap-x-8 sm:grid-cols-2">
          <FactRow>{filled.slice(0, half).map((field) => fact(field.path, field.field))}</FactRow>
          <FactRow>{filled.slice(half).map((field) => fact(field.path, field.field))}</FactRow>
        </div>
      ) : null}
      {blank.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {en ? 'Not filled in: ' : 'لم تُعبّأ: '}
          {blank.map((field) => labelOf(field.path, field.field)).join(en ? ', ' : '، ')}
        </p>
      ) : null}

      {/* The flats of a مبنى, each with its census code. */}
      {unitRows.length > 0 ? (
        <div className="space-y-2">
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
            {/* Two columns only when there are fields to complete beside the facts. */}
            <CardContent className={personalItems.length > 0 ? 'grid gap-6 p-4 lg:grid-cols-2' : 'p-4'}>
              <SummaryList>
                <SummaryRow label={en ? 'Full name' : 'الاسم الكامل'}>{fullName}</SummaryRow>
                <SummaryRow label={en ? "Mother's name" : 'اسم الأم وشهرتها'}>
                  {text(personal.motherName) ?? dash}
                </SummaryRow>
                <SummaryRow label={en ? 'Reference no.' : 'الرقم المرجعي'} className="font-mono">
                  {record?.citizenReferenceNumber ? <span dir="ltr">{record.citizenReferenceNumber}</span> : dash}
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
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-warning">
                    {en ? 'Fields to complete' : 'حقول تحتاج استكمالاً'}
                  </h3>
                  <OpenQuestionList
                    state={state}
                    items={personalItems}
                    base={base}
                    citizenId={citizenId}
                    locale={locale}
                  />
                </div>
              ) : null}
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
                    <div className="grid gap-6 lg:grid-cols-5">
                      <div className="min-w-0 lg:col-span-3">
                        <PropertyDetails
                          values={values}
                          index={index}
                          open={new Set(sectionItems.map((item) => item.path))}
                          census={record?.propertyRefs?.find((entry) => entry.propertyId === card?.id)}
                          locale={locale}
                        />
                      </div>
                      <div className="min-w-0 space-y-2 lg:col-span-2">
                        <h4 className="text-sm font-semibold text-warning">
                          {en ? 'Fields to complete' : 'حقول تحتاج استكمالاً'}
                        </h4>
                        <OpenQuestionList
                          state={state}
                          items={sectionItems}
                          base={base}
                          citizenId={citizenId}
                          locale={locale}
                        />
                      </div>
                    </div>
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
