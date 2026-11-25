'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { getMunicipalitySettings, getTenantConfig, logApiError } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { SummaryRow } from '@/components/ui/summary-list';

/**
 * The parts every printed treasury document shares: «تقرير الصندوق اليومي»,
 * «أمر الصرف» and «سند القبض».
 *
 * One letterhead, one crest, one signature line and one set of print rules, so
 * the three papers a municipality files side by side carry the same heading in
 * the same words, and a fix to one is a fix to all three.
 */

/** The municipality as the letterhead names it, from الإعدادات. */
export interface MunicipalLetterhead {
  name: string;
  governorate: string | null;
  district: string | null;
  /** The crest as a data URI, when the municipality has one. */
  crest: string | null;
}

/** What prints while the letterhead is loading, or when it failed to: the document stays printable. */
export const BLANK_LETTERHEAD: MunicipalLetterhead = { name: '', governorate: null, district: null, crest: null };

/**
 * The letterhead: الإعدادات for the governorate, the district and the crest (a
 * data URI, so it prints without a host the CSP would refuse), the public
 * config for the name when the settings have none. A letterhead that fails to
 * load leaves the name blank rather than the document unprintable, so each
 * failure is logged and the query itself never fails.
 *
 * The locale is in the key because the name it returns depends on it.
 */
export function useMunicipalLetterhead({
  tenant,
  base,
  token,
  locale,
  errorMessage,
}: {
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  errorMessage: string;
}) {
  return useStaffQuery({
    queryKey: ['treasury', tenant, 'letterhead', locale],
    queryFn: async (accessToken): Promise<MunicipalLetterhead> => {
      const [settings, config] = await Promise.allSettled([
        getMunicipalitySettings(tenant, accessToken, { includeLogo: true }),
        getTenantConfig(tenant),
      ]);
      for (const result of [settings, config]) if (result.status === 'rejected') logApiError(result.reason);
      const s = settings.status === 'fulfilled' ? settings.value : null;
      const c = config.status === 'fulfilled' ? config.value : null;
      return {
        name: (locale === 'en' ? s?.nameEn || c?.name : s?.nameAr || c?.nameAr || c?.name) ?? '',
        governorate: s?.governorate ?? null,
        district: s?.district ?? null,
        crest: s?.logoDataUri ?? null,
      };
    },
    tenant,
    base,
    token,
    errorMessage,
    reference: true,
  });
}

/** «الجمهورية اللبنانية / وزارة الداخلية والبلديات / … / بلدية …», top of the sheet. */
export function LetterheadLines({ letterhead }: { letterhead: MunicipalLetterhead }): React.JSX.Element {
  const t = useTranslations('officialDocument.letterhead');
  return (
    <div className="space-y-0.5 text-xs">
      <p className="font-semibold">{t('republic')}</p>
      <p>
        {t('ministry')}
        {letterhead.governorate ? ` — ${t('governorate', { name: letterhead.governorate })}` : ''}
      </p>
      {letterhead.district ? <p>{t('district', { name: letterhead.district })}</p> : null}
      <p className="pt-1 text-base font-semibold">{t('municipality', { name: letterhead.name || '—' })}</p>
    </div>
  );
}

/** The municipality's own crest, when it has uploaded one. Nothing is drawn in its place. */
export function LetterheadCrest({ crest }: { crest: string | null }): React.JSX.Element | null {
  if (!crest) return null;
  // A data URI from الإعدادات: nothing for next/image to optimise, and no host for the CSP.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={crest} alt="" className="size-16 object-contain" />;
}

/** A labelled line of a printed document; the value may wrap, since a statement is prose. */
export function DocumentRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <SummaryRow label={label}>
      <span className="whitespace-normal break-words text-end">{children}</span>
    </SummaryRow>
  );
}

/** «الاسم / التوقيع / التاريخ» with a line to write on, under each signatory's title. */
export function SignatureBlock({ title, note }: { title: string; note?: string }): React.JSX.Element {
  const t = useTranslations('officialDocument.signatures');
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
      {(['name', 'signature', 'date'] as const).map((key) => (
        <div key={key} className="flex items-end gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{t(key)}</span>
          <span aria-hidden className="h-6 flex-1 border-b border-dashed" />
        </div>
      ))}
    </div>
  );
}

/**
 * Opens the browser's print dialog once, when `ready` first turns true — for a
 * page reached from a «طباعة» button, which promises the dialog rather than a
 * second click.
 *
 * After a frame, so the dialog prints the document rather than the skeleton
 * it replaced. The guard is set inside the frame, not before it: React's
 * development double-mount cancels the first frame, and a guard set early
 * would then stop the second from ever printing. `onPrinted` lets the page
 * drop its `?print=1`, so a reload does not print again.
 */
export function useAutoPrint(ready: boolean, onPrinted?: () => void): void {
  const printed = useRef(false);
  useEffect(() => {
    if (!ready || printed.current) return;
    const frame = window.requestAnimationFrame(() => {
      printed.current = true;
      window.print();
      onPrinted?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready, onPrinted]);
}
