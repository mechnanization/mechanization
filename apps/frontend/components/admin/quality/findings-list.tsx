'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CircleCheck, Loader2, ShieldQuestion, Undo2 } from 'lucide-react';
import { qualityLabels, type QualityFindingKind } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import { dismissFinding, getFindings, restoreFinding, type QualityFinding } from '@/lib/quality-api';
import { formatRelative } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const SEVERITY: Record<QualityFinding['severity'], { dot: string; ar: string; en: string }> = {
  HIGH: { dot: 'bg-destructive', ar: 'يستحق النظر الآن', en: 'Look now' },
  MEDIUM: { dot: 'bg-warning', ar: 'يستحق التحقق', en: 'Worth checking' },
  LOW: { dot: 'bg-muted-foreground/50', ar: 'نقص يُستكمل', en: 'A gap to fill' },
};

/**
 * «ملاحظات الجودة» — what the register itself can tell is probably wrong.
 *
 * Derived on every read, so a finding disappears the moment the record is
 * fixed; the only thing stored is «ليست مشكلة» and the reason for it. Two
 * genuine neighbours 4 m apart are a legitimate answer, and the screen's job is
 * to make giving that answer as easy as acting on the real one.
 */
export function FindingsList({
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
  const quality = qualityLabels(locale);
  const toast = useToast();

  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [kind, setKind] = useState<QualityFindingKind | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const query = useStaffQuery({
    queryKey: ['quality-findings', tenant, includeDismissed],
    queryFn: (tok, signal) => getFindings(tenant, tok, { includeDismissed }, signal),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the findings.' : 'تعذّر تحميل ملاحظات الجودة.',
    keepPrevious: true,
  });

  const items = (query.data?.items ?? []).filter((finding) => !kind || finding.kind === kind);
  const counts = query.data?.counts ?? {};
  const kinds = Object.entries(counts)
    .filter(([, value]) => (value?.open ?? 0) > 0 || includeDismissed)
    .sort((a, b) => (b[1]?.open ?? 0) - (a[1]?.open ?? 0));

  const run = async (key: string, work: () => Promise<unknown>, done: string) => {
    if (!token) return;
    setBusy(key);
    try {
      await work();
      toast.success(done);
      setDismissing(null);
      setReason('');
      query.refetch();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : en ? 'Not saved.' : 'لم يُحفظ.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={kind === ''}
          onClick={() => setKind('')}
          className={cn(
            'min-h-9 rounded-md border px-3 text-sm transition-colors',
            kind === '' ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
          )}
        >
          {en ? 'All' : 'الكل'}
        </button>
        {kinds.map(([key, value]) => (
          <button
            key={key}
            type="button"
            aria-pressed={kind === key}
            onClick={() => setKind(key as QualityFindingKind)}
            className={cn(
              'min-h-9 rounded-md border px-3 text-sm transition-colors',
              kind === key ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
            )}
          >
            {quality.findingKind[key as QualityFindingKind] ?? key}
            <span className="ms-1.5 tabular-nums text-muted-foreground">{value?.open ?? 0}</span>
          </button>
        ))}
        <Button
          variant={includeDismissed ? 'default' : 'ghost'}
          size="sm"
          className="ms-auto h-9"
          aria-pressed={includeDismissed}
          onClick={() => setIncludeDismissed((current) => !current)}
        >
          {en ? 'Show dismissed' : 'إظهار «ليست مشكلة»'}
        </Button>
      </div>

      {query.error ? (
        <ErrorState description={query.error} onRetry={query.refetch} />
      ) : query.loading ? (
        <LoadingState label={en ? 'Checking the register…' : 'جارٍ فحص السجل…'} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title={en ? 'Nothing to look at' : 'لا ملاحظات'}
          description={
            en
              ? 'No duplicate records, copied numbers or contradictions were found in the register.'
              : 'لم يُعثر على سجلات مكرَّرة أو أرقام منقولة أو تناقضات في السجل.'
          }
        />
      ) : (
        <ol className="space-y-3">
          {items.map((finding) => {
            const key = `${finding.kind}|${finding.subjectKey}`;
            const severity = SEVERITY[finding.severity];
            return (
              /*
                The same banded card «السجلات» uses, so the two tabs of one
                screen read as one screen.

                What a finding is made of: a headline and its severity, the
                sentence of evidence, the records it is about, and who filed
                them. Those were a heading, a paragraph and a row of outlined
                link-chips — the chips being the thing that made a subject look
                like a control rather than the record it names.
              */
              <li
                key={key}
                className={cn(
                  'overflow-hidden rounded-xl border bg-card',
                  finding.dismissal && 'opacity-70',
                )}
              >
                <div className="divide-y [&>*]:px-4 [&>*]:py-3">
                  <div>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', severity.dot)} />
                      <h3 className="text-sm font-semibold">
                        {quality.findingKind[finding.kind] ?? finding.kind}
                      </h3>
                      {/* Severity as coloured words — the dot already carries it. */}
                      <span className="text-xs text-muted-foreground">{en ? severity.en : severity.ar}</span>
                      {finding.at ? (
                        <span className="ms-auto text-xs text-muted-foreground">
                          {formatRelative(finding.at, locale)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">{finding.detail}</p>
                  </div>

                  {finding.subjects.length > 0 || finding.officers.length > 0 ? (
                    <FactRow columns>
                      {finding.subjects.map((subject) => (
                        <FactCell
                          key={`${key}-${subject.id}`}
                          label={
                            subject.kind === 'citizen'
                              ? en
                                ? 'Citizen'
                                : 'المواطن'
                              : en
                                ? 'Structure'
                                : 'المنشأة'
                          }
                          value={
                            <>
                              <Link
                                href={
                                  subject.kind === 'citizen'
                                    ? `${base}/citizens/${encodeURIComponent(subject.id)}`
                                    : `${base}/buildings/${encodeURIComponent(subject.id)}/matrix`
                                }
                                className="text-primary underline-offset-4 hover:underline"
                              >
                                {subject.label}
                              </Link>
                              {subject.secondary ? (
                                <span className="block text-muted-foreground">{subject.secondary}</span>
                              ) : null}
                            </>
                          }
                        />
                      ))}
                      {finding.officers.length > 0 ? (
                        <FactCell
                          label={en ? 'Filed by' : 'سجَّلها'}
                          value={finding.officers.map((officer) => officer.name).join('، ')}
                        />
                      ) : null}
                    </FactRow>
                  ) : null}

                  {finding.kind === 'UNLINKED_LANDLORDS' ? (
                    <div>
                      <Link
                        href={`${base}/citizens/landlord-links`}
                        className="text-xs text-primary underline-offset-4 hover:underline"
                      >
                        {en ? 'Open the owner-link queue' : 'فتح «روابط المالكين»'}
                      </Link>
                    </div>
                  ) : null}

                {finding.dismissal ? (
                  <div className="flex flex-wrap items-center gap-2 bg-muted/30 text-xs">
                    <ShieldQuestion className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      {en ? 'Not a problem — ' : 'ليست مشكلة — '}
                      {finding.dismissal.reason}
                    </span>
                    <span className="text-muted-foreground">
                      {finding.dismissal.by} · {formatRelative(finding.dismissal.at, locale)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ms-auto h-8 gap-1.5"
                      disabled={busy === key}
                      onClick={() =>
                        run(
                          key,
                          () => restoreFinding(tenant, token!, { kind: finding.kind, subjectKey: finding.subjectKey }),
                          en ? 'Reopened' : 'أُعيد فتح الملاحظة',
                        )
                      }
                    >
                      <Undo2 className="size-3.5" aria-hidden />
                      {en ? 'Reopen' : 'إعادة فتحها'}
                    </Button>
                  </div>
                ) : finding.dismissable ? (
                  dismissing === key ? (
                    <div className="flex flex-wrap items-end gap-2 bg-muted/20">
                      <div className="min-w-[14rem] flex-1 space-y-1">
                        <label htmlFor={`dismiss-${key}`} className="text-xs text-muted-foreground">
                          {en ? 'Why is this not a problem?' : 'لماذا هي ليست مشكلة؟'}
                        </label>
                        <Input
                          id={`dismiss-${key}`}
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          maxLength={500}
                          placeholder={en ? 'e.g. two separate houses, different families' : 'مثال: بيتان منفصلان وعائلتان مختلفتان'}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="h-9"
                        disabled={reason.trim().length < 4 || busy === key}
                        onClick={() =>
                          run(
                            key,
                            () =>
                              dismissFinding(tenant, token!, {
                                kind: finding.kind,
                                subjectKey: finding.subjectKey,
                                reason: reason.trim(),
                              }),
                            en ? 'Marked as not a problem' : 'عُلِّمت «ليست مشكلة»',
                          )
                        }
                      >
                        {busy === key ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {en ? 'Save' : 'حفظ'}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-9" onClick={() => setDismissing(null)}>
                        {en ? 'Cancel' : 'إلغاء'}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex bg-muted/20">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground"
                        onClick={() => {
                          setDismissing(key);
                          setReason('');
                        }}
                      >
                        {en ? 'Not a problem…' : 'ليست مشكلة…'}
                      </Button>
                    </div>
                  )
                ) : (
                  <p className="bg-muted/20 text-xs text-muted-foreground">
                    {en ? 'Closed by fixing the record itself.' : 'تُغلَق بتصحيح السجل نفسه.'}
                  </p>
                )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
