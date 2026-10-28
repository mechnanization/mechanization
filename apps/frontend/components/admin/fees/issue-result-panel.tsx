'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { CircleCheck, UserX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { FeeFrequency } from '@mechanization/shared-schemas';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { useUnassessableWords } from '@/components/admin/fees/unassessable-words';
import type { issueFeeNotice } from '@/lib/api-client';

export type IssueFeeNoticeResult = Awaited<ReturnType<typeof issueFeeNotice>>;

/**
 * What an issued notice did, kept on screen (S8).
 *
 * The page used to say it in up to nine toasts at once — billed, unassessable,
 * exempted, held, uninhabitable, fee-exempt, paid by a co-owner, shared bills,
 * conflicts — and then navigate away, so the citizens nobody could assess were
 * named in a message that closed itself. Here the figures are the server's
 * answer to this issue, the shortfall is a list a clerk can read to the end,
 * and the way on is a choice: the notices, the register, or another fee.
 */
export function IssueResultPanel({
  title,
  frequency,
  result,
  noticesHref,
  feesHref,
  onIssueAnother,
  locale,
}: {
  title: string;
  frequency: FeeFrequency;
  result: IssueFeeNoticeResult;
  noticesHref: string;
  feesHref: string;
  onIssueAnother: () => void;
  locale: string;
}) {
  const t = useTranslations('fees.issuePage');
  const tFees = useTranslations('fees');
  const words = useUnassessableWords(locale);
  const heading = useRef<HTMLHeadingElement>(null);

  // The wizard this replaces held the focus; it moves to what took its place.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  /*
    Each line is the sentence the toasts said, with what it means for the
    clerk: held units are charged from the next period, a one-off fee has no
    next period for an uninhabitable flat, and so on.
  */
  const notCharged = [
    result.exemptedUnits ? t('exempted', { count: result.exemptedUnits }) : null,
    result.heldUnits ? t('held', { count: result.heldUnits }) : null,
    result.uninhabitableUnits
      ? tFees(frequency === 'ONCE' ? 'issue.uninhabitableOnce' : 'issue.uninhabitable', {
          count: result.uninhabitableUnits,
        })
      : null,
    // «معفاة من الرسوم» (0077): the mosque on a waqf parcel, a public building.
    result.feeExemptUnits ? tFees('issue.feeExempt', { count: result.feeExemptUnits }) : null,
    // Not held and not exempt: a co-owned flat «مالك مسؤول» pays for in full.
    result.coOwnerPaidUnits ? tFees('issue.coOwnerPaid', { count: result.coOwnerPaidUnits }) : null,
    // Under TIERED_AREA, units of a type the bracket table never names: outside the notice (D11).
    result.outsideTableUnits ? tFees('issue.outsideTable', { count: result.outsideTableUnits }) : null,
  ].filter((line): line is string => line !== null);

  const unassessable = result.unassessable ?? [];
  const conflicts = result.sharedUnitConflicts?.length ?? 0;

  return (
    // The wizard's width, which it replaces: the counts and lists read side by side from `lg`.
    <div className="w-full space-y-5 rounded-lg border bg-card p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        <div className="space-y-1">
          <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
            {t('resultTitle', { title })}
          </h2>
          <p className="text-sm text-muted-foreground">{t('resultBody')}</p>
        </div>
      </div>

      <StatStrip>
        <StatItem value={result.issued.toLocaleString('en-US')} label={t('resultBills')} />
        {result.sharedBills ? (
          <StatItem value={result.sharedBills.toLocaleString('en-US')} label={t('resultShared')} />
        ) : null}
      </StatStrip>

      {conflicts > 0 ? <Alert variant="warning">{tFees('issue.sharedUnitConflicts', { count: conflicts })}</Alert> : null}

      {/* What went unbilled beside who could not be assessed: two lists a clerk acts on, read across from `lg`. */}
      {notCharged.length > 0 || unassessable.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
          {notCharged.length > 0 ? (
            <section aria-labelledby="issue-not-charged" className="space-y-2">
              <h3 id="issue-not-charged" className="text-sm font-semibold">
                {t('resultNotCharged')}
              </h3>
              <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed">
                {notCharged.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/*
            The skipped are named, not buried. A clerk told only that two hundred
            bills were raised has no way to know that eleven buildings went unbilled
            because nobody has been inside them.
          */}
          {unassessable.length > 0 ? (
            <CollapsibleSection icon={UserX} title={t('unassessable', { count: unassessable.length })}>
              <ul className="divide-y text-sm">
                {/* Who, the unit that stopped them, why and what to do — as the preview said it (`useUnassessableWords`). */}
                {unassessable.map((entry) => {
                  const said = words(entry);
                  return (
                    <li key={entry.citizenId} className="space-y-0.5 py-2">
                      <p className="font-medium">{entry.name}</p>
                      {said.where ? (
                        <p className="text-xs">
                          {said.where}
                          {said.facts ? <span className="text-muted-foreground"> · {said.facts}</span> : null}
                        </p>
                      ) : null}
                      <p className="text-xs">{said.why}</p>
                      {said.fix ? <p className="text-xs text-muted-foreground">{said.fix}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </CollapsibleSection>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button asChild>
          <Link href={noticesHref}>{t('toNotices')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={feesHref}>{t('back')}</Link>
        </Button>
        <Button variant="ghost" onClick={onIssueAnother}>
          {t('issueAnother')}
        </Button>
      </div>
    </div>
  );
}
