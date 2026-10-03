'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Check, ClipboardCheck, FileText, Loader2, Paperclip, UserRound } from 'lucide-react';
import { getLabels, type CitizenResidence } from '@mechanization/shared-schemas';
import {
  OpenQuestionList,
  RecordCompletionEmpty,
  RecordCompletionNotices,
  RecordCompletionSummary,
  saveLabel,
  useRecordCompletion,
  type OpenItem,
} from '@/components/admin/complete-record-dialog';
import { DocumentList } from '@/components/admin/document-list';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { listRegistrationDocuments } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';

/** A form value as display text, or null when it holds nothing. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Up to this many property sections open on arrival; past it, only the first. */
const OPEN_SECTIONS_LIMIT = 2;

/**
 * «فحص الملف» — one record from «يتطلب مراجعة», laid out in the order a
 * reviewer reads a file:
 *
 *  1. **The citizen**, always first: who this is and how to reach them, with
 *     any open personal or contact field highlighted in the same card.
 *  2. **One section per property that has an open field**, holding that
 *     property's own facts, its own attachments and only its open fields.
 *     Collapsible, so a file with gaps on four properties does not arrive as
 *     one long form; up to `OPEN_SECTIONS_LIMIT` arrive open.
 *  3. **The record's other attachments** — identity and the like — opened
 *     through the audited signed-URL route, so the answer can be checked
 *     against the paper.
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

  const registrationId = record?.registrationId ?? null;
  const documentsQuery = useStaffQuery({
    queryKey: ['documents', tenant, registrationId],
    queryFn: (accessToken, signal) => listRegistrationDocuments(tenant, accessToken, registrationId!, signal),
    tenant,
    base,
    // Read once the record says which registration it is.
    token: registrationId ? token : null,
    errorMessage: en ? 'Could not load the attachments.' : 'تعذّر تحميل المرفقات.',
  });
  const documents = documentsQuery.data?.items ?? [];

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

  // Attachments that belong to a property section are shown there; the rest here.
  const sectionCardIds = new Set(
    propertySections.map(([index]) => values?.properties[index]?.id).filter(Boolean) as string[],
  );
  const recordDocuments = documents.filter(
    (document) => !document.propertyEntryId || !sectionCardIds.has(document.propertyEntryId),
  );

  const openCount = (count: number) =>
    en ? `${count} open` : `${count} مفتوح`;

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

          {/* 2 — One section per property with an open field: its facts, its papers, its gaps. */}
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
                const cardDocuments = documents.filter(
                  (document) => card?.id && document.propertyEntryId === card.id,
                );
                const title = [
                  en ? `Property ${index + 1}` : `العقار ${index + 1}`,
                  type,
                  role,
                ]
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
                    <div className="grid gap-6 lg:grid-cols-2">
                      <div className="space-y-4">
                        <SummaryList>
                          <SummaryRow label={labels.citizenField.propertyNumber}>
                            {text(card?.propertyNumber) ? (
                              <span dir="ltr" className="font-mono">{card!.propertyNumber}</span>
                            ) : (
                              dash
                            )}
                          </SummaryRow>
                          {text(card?.buildingName) ? (
                            <SummaryRow label={labels.citizenField.buildingName}>{card!.buildingName}</SummaryRow>
                          ) : null}
                          {text(card?.neighborhood) ? (
                            <SummaryRow label={labels.citizenField.neighborhood}>{card!.neighborhood}</SummaryRow>
                          ) : null}
                          {card?.occupancyType && card.occupancyType !== 'OWNER' && text(card.landlordName) ? (
                            <SummaryRow label={labels.citizenField.landlordName}>{card.landlordName}</SummaryRow>
                          ) : null}
                        </SummaryList>
                        {cardDocuments.length > 0 ? (
                          <div className="space-y-2">
                            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                              <Paperclip className="size-3.5" aria-hidden />
                              {en ? 'Attachments for this property' : 'مرفقات هذا العقار'}
                            </h4>
                            <DocumentList
                              documents={cardDocuments}
                              tenant={tenant}
                              base={base}
                              token={token}
                              locale={locale}
                            />
                          </div>
                        ) : null}
                      </div>
                      <OpenQuestionList
                        state={state}
                        items={sectionItems}
                        base={base}
                        citizenId={citizenId}
                        locale={locale}
                      />
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

          {/* 3 — The record's other papers, to check an answer against. */}
          <Card>
            <CardHeader className="border-b px-4 py-3.5">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Paperclip className="size-5 text-primary" aria-hidden />
                <h2>{en ? 'Attachments' : 'المرفقات'}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              {documentsQuery.error ? (
                <ErrorState
                  compact
                  title={documentsQuery.error}
                  onRetry={documentsQuery.refetch}
                  retryLabel={en ? 'Try again' : 'إعادة المحاولة'}
                />
              ) : documentsQuery.loading ? (
                <SkeletonText lines={2} />
              ) : (
                <DocumentList
                  documents={recordDocuments}
                  tenant={tenant}
                  base={base}
                  token={token}
                  locale={locale}
                  emptyLabel={
                    documents.length > 0
                      ? en
                        ? 'Every attachment on this record is listed with its property above.'
                        : 'كل مرفقات هذا السجل معروضة مع عقارها أعلاه.'
                      : en
                        ? 'No attachments were filed with this record.'
                        : 'لم تُرفق مستندات بهذا السجل.'
                  }
                />
              )}
            </CardContent>
          </Card>

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
