'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Loader2, PencilLine, Undo2 } from 'lucide-react';
import { getLabels, qualityLabels } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import { completeQualityCheck, getMyQualityTasks } from '@/lib/quality-api';
import { formatDate, formatRelative } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { AnswerForm } from '@/components/admin/quality/checks-panel';
import { Badge } from '@/components/ui/badge';
import { Fact, FactGrid } from '@/components/ui/fact-grid';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

/**
 * «مهام الجودة» — what is waiting on this member of staff.
 *
 * Their own returned records, with the reviewer's sentence and a link straight
 * into the form that closes it, and the re-checks they may do (never their own
 * filings). It renders nothing at all when both are empty: an officer's screen
 * should not carry a permanent panel telling them their work is being watched.
 */
export function MyQualityTasks({
  tenant,
  base,
  locale,
  token,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const quality = qualityLabels(locale);
  const toast = useToast();
  const [answering, setAnswering] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const query = useStaffQuery({
    queryKey: ['quality-my-tasks', tenant],
    queryFn: (tok, signal) => getMyQualityTasks(tenant, tok, signal),
    tenant,
    base,
    token,
    errorMessage: '',
  });

  const returned = query.data?.returned ?? [];
  const checks = query.data?.checks ?? [];
  if (returned.length === 0 && checks.length === 0) return null;

  const complete = async (
    checkId: string,
    input: Parameters<typeof completeQualityCheck>[3],
  ) => {
    if (!token) return;
    setBusy(checkId);
    try {
      await completeQualityCheck(tenant, token, checkId, input);
      toast.success(en ? 'Check recorded' : 'سُجِّل التحقق');
      setAnswering(null);
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : en ? 'Not saved.' : 'لم يُحفظ.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="my-quality-tasks">
      <h2 id="my-quality-tasks" className="text-base font-bold">
        {en ? 'Waiting on you' : 'بانتظارك'}
      </h2>

      {returned.length > 0 ? (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-warning">
            <Undo2 className="size-4" aria-hidden />
            {en ? `Records sent back (${returned.length})` : `سجلات أُعيدت إليك (${returned.length})`}
          </h3>
          <ol className="space-y-2">
            {returned.map((item) => (
              <li key={item.citizenId} className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Link
                    href={`${base}/citizens/${encodeURIComponent(item.citizenId)}`}
                    className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    {item.citizenName}
                  </Link>
                  <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                    {item.referenceNumber}
                  </span>
                  <span className="ms-auto text-xs text-muted-foreground">
                    {item.by ? `${item.by} · ` : ''}
                    {formatRelative(item.at, locale)}
                  </span>
                </div>
                {item.reason ? <p className="mt-1 text-sm leading-relaxed">{item.reason}</p> : null}
                {item.fields.length > 0 ? (
                  <FactGrid labelWidth="7rem" className="mt-1.5">
                    <Fact
                      label={en ? 'Fields to fix' : 'الحقول المطلوب تصحيحها'}
                      value={item.fields.map((field) => quality.reviewField[field] ?? field).join('، ')}
                    />
                  </FactGrid>
                ) : null}
                <Link
                  href={`${base}/citizens/${encodeURIComponent(item.citizenId)}/edit`}
                  className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
                >
                  <PencilLine className="size-3.5" aria-hidden />
                  {en ? 'Open and correct' : 'فتح السجل وتصحيحه'}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {checks.length > 0 ? (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <ClipboardList className="size-4 text-primary" aria-hidden />
            {en ? `Field re-checks you can do (${checks.length})` : `تحقق ميداني يمكنك القيام به (${checks.length})`}
          </h3>
          <ol className="space-y-2">
            {checks.map((check) => (
              <li key={check.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Link
                    href={`${base}/citizens/${encodeURIComponent(check.citizen.id)}`}
                    className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    {check.citizen.name}
                  </Link>
                  {check.assignedTo ? (
                    <Badge variant="soft-info" className="text-[10px]">
                      {en ? 'Assigned to you' : 'مُسنَد إليك'}
                    </Badge>
                  ) : null}
                  <span className="ms-auto text-xs text-muted-foreground">
                    {en ? 'Filed by' : 'سجَّله'} {check.originalOfficer?.name ?? '—'} · {formatDate(check.filedAt)}
                  </span>
                </div>
                <div className="mt-1.5 space-y-2">
                  {check.properties.map((card, index) => (
                    <FactGrid key={`${check.id}-${index}`} labelWidth="7rem" className="text-xs">
                      <Fact
                        label={en ? 'Type' : 'النوع'}
                        value={labels.propertyType[card.propertyType as never] ?? card.propertyType}
                      />
                      {card.propertyNumber ? (
                        <Fact label={en ? 'Parcel' : 'رقم العقار'} value={card.propertyNumber} />
                      ) : null}
                      {card.buildingCode || card.buildingName ? (
                        <Fact
                          label={en ? 'Building' : 'المبنى'}
                          value={[card.buildingCode, card.buildingName].filter(Boolean).join(' — ')}
                        />
                      ) : null}
                      {card.units.length > 0 ? (
                        <Fact label={en ? 'Units' : 'الوحدات'} value={card.units.join('، ')} />
                      ) : null}
                    </FactGrid>
                  ))}
                </div>

                {answering === check.id ? (
                  <AnswerForm
                    locale={locale}
                    busy={busy === check.id}
                    onCancel={() => setAnswering(null)}
                    onSubmit={(input) => complete(check.id, input)}
                  />
                ) : (
                  <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setAnswering(check.id)}>
                    {busy === check.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {en ? 'Record what you found' : 'تسجيل ما وجدته'}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
