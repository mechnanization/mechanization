'use client';

import { use, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Receipt as ReceiptIcon, Share2, Wallet } from 'lucide-react';
import { REFERENCE_SEND_ROLES } from '@/lib/staff-roles';
import {
  getCitizenProfile,
  getMunicipalitySettings,
  getMyRound,
  getTenantConfig,
  logApiError,
  type CitizenProfile,
  type CitizenProfilePayment,
  type CollectorRoundCurrency,
  type CollectorRoundRow,
} from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { municipalityNameFor } from '@/lib/municipality-name';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { PaymentReceipt, type RecordedMovement } from '@/components/admin/payment-receipt';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

/**
 * «جولتي» — what the collector is carrying, and which doors it came from.
 *
 * Built for a phone held in one hand on a doorstep, so the money is the first
 * thing on the screen and the list below it is cards rather than a table: a
 * table on a 390px screen is a row of truncations.
 *
 * ## Why this screen is allowed to exist at all
 *
 * The treasury is closed to collectors, and should be — a man who carries cash
 * has no business reading the municipality's books. But «كم بجيبتي؟» is his own
 * question about his own pocket, and refusing to answer it does not make the
 * cash safer. The route is scoped by the session and takes no id, so this page
 * can only ever show the person looking at it.
 *
 * ## The two figures, and why they can differ
 *
 * «نقدي الآن» is the ledger's figure and the one that counts. The receipts
 * below are everything since his last handover. After a *partial* handover
 * those receipts cannot account for all of what he holds — a handover moves an
 * amount, not a set of receipts — so the remainder is named («محمول من جولة
 * سابقة») instead of being left as an unexplained gap between two numbers.
 */
export default function MyRoundPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.myRound');
  const tCommon = useTranslations('common');
  const { token, user } = useStaffSession(tenant, base);

  const round = useStaffQuery({
    queryKey: ['treasury', tenant, 'my-round'],
    queryFn: (accessToken, signal) => getMyRound(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  /*
    The office details a reopened وصل prints: the settings and the
    municipality's name. Read once with the page and held for the session
    (`reference`), under the key the payments page reads the same pair with, so
    its shape stays theirs: the name in it is the Arabic one. The citizen's own
    file is the read made only when a receipt is opened (`openReceipt`).
  */
  const context = useStaffQuery({
    queryKey: ['receipt-context', tenant],
    queryFn: async (accessToken) => {
      const [settings, config] = await Promise.all([
        getMunicipalitySettings(tenant, accessToken),
        getTenantConfig(tenant),
      ]);
      return { settings, municipalityName: config.nameAr || config.name };
    },
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });
  /** In the page's language: the English name on /en/ once the municipality has entered one. */
  const municipalityName = municipalityNameFor(locale, {
    nameAr: context.data?.municipalityName,
    nameEn: context.data?.settings.nameEn,
  });

  const [receipt, setReceipt] = useState<{
    citizen: CitizenProfile;
    payment: CitizenProfilePayment;
    recorded: RecordedMovement;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  /** Reopens the وصل for one door, exactly as the desk screens do. */
  const openReceipt = useCallback(
    async (row: CollectorRoundRow) => {
      if (!token) return;
      setBusyId(row.id);
      setShareError(null);
      try {
        const profile = await getCitizenProfile(tenant, token, row.citizenId);
        const payment = profile.payments.find((entry) => entry.id === row.paymentId);
        if (!payment) {
          setShareError(t('receiptMissing'));
          return;
        }
        setReceipt({
          citizen: profile,
          payment,
          /*
            What this round recorded for the door: its RCP number and its day. Without
            `recorded` the receipt falls back to the bill's reference and today's date,
            which is a different document from the one the citizen was handed (STA-6).
            The round row carries no tender or change, so there is nothing to describe.
          */
          recorded: {
            receiptNumber: row.receiptNumber,
            occurredAt: row.occurredAt,
            received: row.amount,
            remaining: payment.remaining,
            changeGiven: 0,
            tender: null,
            // Every door on a round is a collector's receipt, whatever the bill's last movement was.
            method: 'COLLECTOR',
          },
        });
      } catch (caught) {
        logApiError(caught);
        setShareError(t('receiptError'));
      } finally {
        setBusyId(null);
      }
    },
    [tenant, token, t],
  );

  const data = round.data;
  const rows = data?.rows ?? [];
  const settings = context.data?.settings ?? null;
  /** Is there anything in any pocket? Decides which "no receipts" copy is true. */
  const carrying = (data?.currencies ?? []).some((wallet) => wallet.held > 0);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6">
      <PageHeader icon={Wallet} title={t('title')} />

      {round.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={round.error} onRetry={round.refetch} retryLabel={tCommon('retry')} />
          </CardContent>
        </Card>
      ) : round.loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : data && data.currencies.length === 0 ? (
        /* Not an error: most staff carry nothing, and that is the answer. */
        <Card>
          <CardContent className="p-0">
            <EmptyState title={t('noCustody')} description={t('noCustodyHint')} />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* The money first — it is why the screen was opened. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {(data?.currencies ?? []).map((wallet) => (
              <PocketCard key={wallet.currency} wallet={wallet} locale={locale} t={t} />
            ))}
          </div>

          {shareError ? (
            <Alert variant="warning" live="status">
              {shareError}
            </Alert>
          ) : null}

          <section className="space-y-2">
            <h2 className="px-1 text-sm font-semibold text-muted-foreground">
              {data?.lastHandoverAt
                ? t('sinceHandover', { when: formatDateTime(data.lastHandoverAt) })
                : t('sinceStart')}
            </h2>

            {rows.length === 0 ? (
              <Card>
                <CardContent className="p-0">
                  {/*
                    Two different situations, and the copy must not conflate
                    them: an empty pocket means he handed everything in, while
                    an empty list over a *full* pocket means a partial handover
                    left money with no receipt after it to explain it.
                  */}
                  {carrying ? (
                    <EmptyState title={t('empty')} description={t('emptyHint')} />
                  ) : (
                    <EmptyState title={t('emptySettled')} description={t('emptySettledHint')} />
                  )}
                </CardContent>
              </Card>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li key={row.id}>
                    <Card>
                      <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
                        <div className="min-w-0 space-y-1">
                          <p className="truncate font-semibold">{row.citizenName}</p>
                          <p className="truncate text-xs text-muted-foreground">{row.paymentTitle}</p>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {/* Codes are codes: mono, Latin, left to right (BAN-9, RTL-2). */}
                            {row.unitCode ? (
                              <span dir="ltr" className="font-mono">
                                {row.buildingCode ? `${row.buildingCode}-${row.unitCode}` : row.unitCode}
                              </span>
                            ) : (
                              <span>{t('noUnit')}</span>
                            )}
                            <span dir="ltr" className="font-mono">
                              {row.receiptNumber}
                            </span>
                            <span className="tabular-nums">{formatDateTime(row.occurredAt)}</span>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <TreasuryAmount
                            amount={row.amount}
                            currency={row.currency}
                            locale={locale}
                            className="text-base font-bold"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === row.id}
                            onClick={() => void openReceipt(row)}
                          >
                            {busyId === row.id ? (
                              <ReceiptIcon className="size-4 animate-pulse" aria-hidden />
                            ) : (
                              <Share2 className="size-4" aria-hidden />
                            )}
                            {t('receipt')}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {receipt ? (
        <PaymentReceipt
          open
          onOpenChange={(next) => {
            if (!next) setReceipt(null);
          }}
          tenant={tenant}
          canSend={hasRole(REFERENCE_SEND_ROLES, user?.role)}
          citizen={receipt.citizen}
          payment={receipt.payment}
          recorded={receipt.recorded}
          municipalityName={municipalityName}
          governorate={settings?.governorate}
          district={settings?.district}
          contactPhone={settings?.contactPhone}
          officeWhatsapp={settings?.whatsappNumber}
          locale={locale}
        />
      ) : null}
    </div>
  );
}

/**
 * One currency's pocket.
 *
 * `held` is the ledger's figure and is printed large. `carriedOver` appears
 * only when it is non-zero, because on an ordinary day the receipts below add
 * up to the figure above and a line explaining that they do would be noise.
 */
function PocketCard({
  wallet,
  locale,
  t,
}: {
  wallet: CollectorRoundCurrency;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{t('inHand')}</p>
        <TreasuryAmount
          amount={wallet.held}
          currency={wallet.currency}
          locale={locale}
          className="text-2xl font-bold"
        />
        {wallet.carriedOver > 0 ? (
          <p className="pt-1 text-xs text-muted-foreground">
            {t('carriedOver', { amount: formatMoney(wallet.listed, wallet.currency, locale) })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
