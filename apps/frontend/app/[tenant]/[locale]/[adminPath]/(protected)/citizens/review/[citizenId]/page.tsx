'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCheck, FileText, Loader2, UserRound } from 'lucide-react';
import { getLabels, type CitizenResidence } from '@mechanization/shared-schemas';
import {
  RecordCompletionBody,
  RecordCompletionSummary,
  useRecordCompletion,
} from '@/components/admin/complete-record-dialog';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonText } from '@/components/ui/skeleton';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { formatDate } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
import { useStaffSession } from '@/lib/use-staff-session';

/** A form value as display text, or null when it holds nothing. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * «فحص الملف» — one record from «يتطلب مراجعة»: who it is, and only the fields
 * still open on it, each with the reason it was left open and a box for the
 * answer.
 *
 * The open questions are `useRecordCompletion` — the same load, rules and save
 * as the «استكمال البيانات الناقصة» dialog on the citizen's file, so the two
 * can never disagree about what is open or how it clears. A page rather than
 * that dialog because this is the queue's own work: it has an address a clerk
 * can be sent to (BAN-10), and finishing one record returns to the queue for
 * the next.
 *
 * The profile beside it is read from the same response; nothing else is
 * fetched (CODE-5).
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
  const { values, record, items, saving } = state;

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

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Who the record is — enough to recognise them and reach them. */}
        <Card className="h-fit">
          <CardHeader className="border-b px-4 py-3.5">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <UserRound className="size-5 text-primary" aria-hidden />
              {en ? 'Citizen' : 'المواطن'}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 py-2">
            {values ? (
              <SummaryList>
                <SummaryRow label={en ? 'Full name' : 'الاسم الكامل'}>{fullName}</SummaryRow>
                <SummaryRow label={en ? "Mother's name" : 'اسم الأم وشهرتها'}>
                  {text(personal.motherName) ?? dash}
                </SummaryRow>
                <SummaryRow label={en ? 'Reference no.' : 'الرقم المرجعي'} className="font-mono">
                  {record?.citizenReferenceNumber ? (
                    <span dir="ltr">{record.citizenReferenceNumber}</span>
                  ) : (
                    dash
                  )}
                </SummaryRow>
                <SummaryRow label={en ? 'Phone' : 'الهاتف'}>
                  {phone ? (
                    <a
                      href={`tel:${phone}`}
                      dir="ltr"
                      className="tabular-nums text-primary underline-offset-2 hover:underline"
                    >
                      {formatPhone(phone)}
                    </a>
                  ) : (
                    dash
                  )}
                </SummaryRow>
                <SummaryRow label={en ? 'File type' : 'نوع الملف'}>
                  {labels.citizenResidence[residence ?? 'RESIDENT']}
                </SummaryRow>
                <SummaryRow label={en ? 'Status' : 'الحالة'}>
                  <Badge variant="soft-warning">{labels.citizenRecordStatus.REQUIRES_REVIEW}</Badge>
                </SummaryRow>
                {record?.lastStaffEdit ? (
                  <SummaryRow label={en ? 'Last changed' : 'آخر تعديل'}>
                    <span className="tabular-nums">{formatDate(record.lastStaffEdit.at)}</span>
                    {record.lastStaffEdit.name ? ` · ${record.lastStaffEdit.name}` : null}
                  </SummaryRow>
                ) : null}
              </SummaryList>
            ) : state.loadError ? (
              <p className="py-3 text-xs text-muted-foreground">{dash}</p>
            ) : (
              <SkeletonText lines={5} className="py-3" />
            )}
          </CardContent>
        </Card>

        {/* Only what is still open — the reason this record is in the queue. */}
        <Card className="lg:col-span-2">
          <CardHeader className="border-b px-4 py-3.5">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <ClipboardCheck className="size-5 text-warning" aria-hidden />
              {en ? 'Fields to complete' : 'البيانات المطلوب استكمالها'}
              {items.length > 0 ? (
                <span className="text-sm font-normal tabular-nums text-muted-foreground">
                  ({items.length})
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <RecordCompletionBody state={state} base={base} citizenId={citizenId} locale={locale} />
          </CardContent>
          {values && items.length > 0 ? (
            <div className="flex flex-col gap-3 border-t bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
              <RecordCompletionSummary state={state} locale={locale} />
              <Button
                type="button"
                className="shrink-0 gap-1.5"
                disabled={saving || !token}
                onClick={() => void state.save()}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-4" aria-hidden />
                )}
                {en ? 'Save answers' : 'حفظ الإجابات'}
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
