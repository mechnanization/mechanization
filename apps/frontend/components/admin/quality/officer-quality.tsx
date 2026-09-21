'use client';

import { UsersRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getOfficerQuality, type OfficerQuality as OfficerQualityRow } from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { cn } from '@/lib/utils';

/**
 * «أداء الموظفين» — the work beside its quality, and nothing about pay.
 *
 * Deliberately not a score. Each figure names something a person can open:
 * records filed, records sent back, findings about them, how often a re-check
 * on the ground found something different. The last one is the only number here
 * that is evidence rather than a proxy, so it is the one that reads largest.
 */
export function OfficerQuality({
  tenant,
  base,
  locale,
  token,
  officerId,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  /** Set for one officer's own panel; absent lists everyone who filed anything. */
  officerId?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const query = useStaffQuery({
    queryKey: ['quality-officers', tenant, officerId ?? 'all'],
    queryFn: (tok, signal) => getOfficerQuality(tenant, tok, { officerId }, signal),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the figures.' : 'تعذّر تحميل الأرقام.',
  });

  if (query.error) return <ErrorState description={query.error} onRetry={query.refetch} />;
  if (query.loading) return <LoadingState label={en ? 'Loading…' : 'جارٍ التحميل…'} />;

  const officers = query.data?.officers ?? [];
  if (officers.length === 0) {
    return (
      <EmptyState
        icon={UsersRound}
        title={en ? 'No filings yet' : 'لا سجلات بعد'}
        description={en ? 'Figures appear once records are filed.' : 'تظهر الأرقام بعد تسجيل أول سجل.'}
      />
    );
  }

  return (
    <ol className="space-y-3">
      {officers.map((officer) => (
        <li key={officer.id} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold">{officer.name}</h3>
            {/* A role is a fact about the person, not a state of this card. */}
            {officer.role ? (
              <span className="text-xs text-muted-foreground">
                {(labels.staffRole as Record<string, string>)[officer.role] ?? officer.role}
              </span>
            ) : null}
            {officer.isActive ? null : (
              <span className="text-xs text-destructive">{en ? 'Disabled' : 'معطَّل'}</span>
            )}
            <span className="ms-auto text-xs text-muted-foreground">
              {en ? `${officer.filed} records filed` : `${officer.filed} سجلاً`}
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure
              label={en ? 'Re-checks that differed' : 'تحقق ميداني وجد اختلافاً'}
              value={
                officer.checks.done === 0
                  ? '—'
                  : `${officer.checks.differsRate}% (${officer.checks.differs}/${officer.checks.done})`
              }
              tone={officer.checks.differsRate != null && officer.checks.differsRate >= 30 ? 'warn' : 'plain'}
              hint={officer.checks.done === 0 ? (en ? 'no check done yet' : 'لا تحقق بعد') : undefined}
            />
            <Figure
              label={en ? 'Sent back for correction' : 'أُعيدت للتصحيح'}
              value={String(officer.reviews.returned)}
              tone={officer.reviews.waitingOnOfficer > 0 ? 'warn' : 'plain'}
              hint={
                officer.reviews.waitingOnOfficer > 0
                  ? en
                    ? `${officer.reviews.waitingOnOfficer} still waiting`
                    : `${officer.reviews.waitingOnOfficer} بانتظار التصحيح`
                  : en
                    ? `${officer.reviews.approved} approved`
                    : `${officer.reviews.approved} معتمدة`
              }
            />
            <Figure
              label={en ? 'Open findings' : 'ملاحظات جودة مفتوحة'}
              value={String(officer.findings.open)}
              tone={officer.findings.open > 0 ? 'warn' : 'plain'}
              hint={[
                officer.findings.duplicateCitizens
                  ? en
                    ? `${officer.findings.duplicateCitizens} duplicate`
                    : `${officer.findings.duplicateCitizens} تكرار`
                  : null,
                officer.findings.landlordPhoneCopies
                  ? en
                    ? `${officer.findings.landlordPhoneCopies} phone`
                    : `${officer.findings.landlordPhoneCopies} هاتف`
                  : null,
                officer.findings.nearDuplicateBuildings
                  ? en
                    ? `${officer.findings.nearDuplicateBuildings} buildings`
                    : `${officer.findings.nearDuplicateBuildings} مبانٍ`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <Figure
              label={en ? 'Records with unverified fields' : 'سجلات فيها حقول غير مؤكَّدة'}
              value={String(officer.flaggedRecords)}
              hint={
                officer.filed > 0
                  ? `${Math.round((officer.flaggedRecords / officer.filed) * 100)}%`
                  : undefined
              }
            />
          </dl>

          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {en ? 'Buildings created' : 'مبانٍ أنشأها'}: {officer.buildingsCreated}
            </span>
            {officer.buildingsWithoutPin > 0 ? (
              <span>
                {en ? 'without an entrance pin' : 'بلا دبوس مدخل'}: {officer.buildingsWithoutPin}
              </span>
            ) : null}
            {officer.acknowledgedDuplicateBuildings.count > 0 ? (
              <span>
                {en ? 'created beside an existing structure' : 'أُنشئت رغم وجود منشأة'}:{' '}
                {officer.acknowledgedDuplicateBuildings.count}
                {officer.acknowledgedDuplicateBuildings.nearestMetres != null
                  ? en
                    ? ` (nearest ${officer.acknowledgedDuplicateBuildings.nearestMetres} m)`
                    : ` (أقربها ${officer.acknowledgedDuplicateBuildings.nearestMetres} م)`
                  : ''}
              </span>
            ) : null}
          </p>
        </li>
      ))}
    </ol>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'warn';
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs leading-snug text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'warn' ? 'text-warning' : 'text-foreground',
        )}
      >
        {value}
      </dd>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export type { OfficerQualityRow };
