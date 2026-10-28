'use client';

import { use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Ban,
  Banknote,
  CalendarDays,
  Coins,
  Eraser,
  Loader2,
  Pencil,
  ReceiptText,
  RotateCcw,
} from 'lucide-react';
import {
  ADJUSTMENT_REASON_MIN,
  BACKDATE_WINDOW_DAYS,
  canOverrideCashRules,
  cancelBillSchema,
  daysBetween,
  getLabels,
  municipalToday,
  roundRate,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  cancelBill,
  type CancelBillResult,
  type CitizenProfile,
  type CitizenProfilePayment,
  getCitizenProfile,
  getMunicipalitySettings,
  getPaymentById,
  getTenantConfig,
  logApiError,
  type PaymentLedgerEntry,
  settlePayment,
} from '@/lib/api-client';
import { defaultPayer } from '@/lib/shared-bill-payer';
import { SharedBillPayerField } from '@/components/admin/fees/shared-bill-payer';
import { receiptOfEntry } from '@/lib/bill-receipts';
import { useStaffSession } from '@/lib/use-staff-session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate } from '@/lib/dates';
import { formatForeign, formatLbp, formatTypedAmount, parseAmount } from '@/lib/currency';
import { heldKey, keyIsSpent, spendKey } from '@/lib/request-id';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { PaymentReceipt, type RecordedMovement } from '@/components/admin/payment-receipt';
import { BillReceipts } from '@/components/admin/finance/bill-receipts';
import { cn } from '@/lib/utils';
import {
  BILL_CANCEL_ROLES,
  CASH_COUNTER_ROLES,
  PAYMENT_SETTLE_ROLES,
  REQUEST_READ_ROLES,
  hasRole,
} from '@/lib/staff-roles';

/** What the citizen is paying in. «BOTH» is «20$ و200,000 ليرة» handed over together. */
type PayIn = 'LBP' | 'FOREIGN' | 'BOTH';

/**
 * «تسجيل دفعة نقدية» — cash taken at the counter against one ليرة bill.
 *
 * The clerk picks what the citizen is paying in — ليرة, the municipality's
 * second currency, or both at once — and types the amount. The rate is the
 * municipality's own from الإعدادات, shown with its date. Only a finance role
 * (SUPER_ADMIN, ACCOUNTANT) may take one payment at another rate, and then
 * with a reason; a payment dated before today also states why, and more than
 * `BACKDATE_WINDOW_DAYS` back is a finance correction. The server enforces all
 * of it (`cash-policy.ts`); the page explains it before the press.
 *
 * A note larger than the balance settles the bill and shows «الباقي» to hand
 * back. Everything here is a preview: the server works the credit and the
 * change out again, refuses what it must, and the receipt prints what the
 * server recorded — its receipt number and its date.
 */
export default function SettleCashPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; citizenId: string; paymentId: string }>;
}) {
  const { tenant, locale, adminPath, citizenId, paymentId } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  // The counter's shared copy (`counterPayment`); this page's older copy is still inline (TXT-1).
  const t = useTranslations('counterPayment');
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const citizenHref = `${base}/citizens/${encodeURIComponent(citizenId)}`;
  /** The counter settle page for this bill: any method, and the collector's own collection. */
  const settleHref = `${base}/fees/payments/${encodeURIComponent(paymentId)}/settle`;
  const today = useMemo(() => municipalToday(), []);

  const { token, user } = useStaffSession(tenant, base);
  const finance = canOverrideCashRules(user?.role);

  // A role that cannot settle has nothing to do here; the file is where it came from.
  useEffect(() => {
    if (!user) return;
    // `PAYMENT_SETTLE_ROLES` mirrors the route's `@Roles`; the server is the enforcement.
    if (!hasRole(PAYMENT_SETTLE_ROLES, user.role)) router.replace(citizenHref);
    /*
      A collector settles, but never cash into the safe, which is all this page
      records (D13, `COLLECTOR_CANNOT_SELECT_METHOD`): the counter settle page
      records his own collection, or a Whish transfer.
    */
    else if (!hasRole(CASH_COUNTER_ROLES, user.role)) router.replace(settleHref);
  }, [user, router, citizenHref, settleHref]);

  const profile = useStaffQuery({
    queryKey: ['citizen-profile', tenant, citizenId],
    queryFn: (tok) => getCitizenProfile(tenant, tok, citizenId),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the bill.' : 'تعذّر تحميل الفاتورة.',
  });
  const settingsQuery = useStaffQuery({
    queryKey: ['municipality-settings', tenant],
    queryFn: (tok) => getMunicipalitySettings(tenant, tok),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the exchange rate.' : 'تعذّر تحميل سعر الصرف.',
  });
  const settings = settingsQuery.data ?? null;
  const [municipalityName, setMunicipalityName] = useState(tenant);
  useEffect(() => {
    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(config.nameAr || config.name))
      .catch(() => setMunicipalityName(tenant));
  }, [tenant]);

  const citizen = profile.data ?? null;
  const payment = useMemo(
    () => citizen?.payments.find((candidate) => candidate.id === paymentId) ?? null,
    [citizen, paymentId],
  );

  /*
    A shared unit bill (0099, D5) is owed in full by everyone registered on the
    unit and paid by one of them, whom the receipt names; the server refuses a
    payment on it that names nobody (`SHARED_BILL_PAYER_REQUIRED`). This page
    never asked, so a shared bill could not be paid from a citizen's file at all
    (2026-10-27). Its debtors are read for such a bill only, and the choice
    starts on this file's citizen (`defaultPayer`).
  */
  const shared = Boolean(payment?.sharedUnit);
  const bill = useStaffQuery({
    queryKey: ['fee-payment', tenant, paymentId],
    queryFn: (tok) => getPaymentById(tenant, tok, paymentId),
    tenant,
    base,
    // No token, no read: an ordinary bill never asks.
    token: shared ? token : null,
    errorMessage: t('payersFailed'),
  });
  const debtors = bill.data?.sharedDebtors;
  const [paidBy, setPaidBy] = useState('');
  useEffect(() => {
    if (paidBy === '' && debtors && debtors.length > 0) setPaidBy(defaultPayer(debtors, citizenId));
  }, [debtors, paidBy, citizenId]);
  /** Another co-owner is paying: the receipt is theirs, rebuilt from their own file, read as soon as they are chosen. */
  const otherPayer = shared && paidBy !== '' && paidBy !== citizenId;
  const payerFile = useStaffQuery({
    queryKey: ['citizen-profile', tenant, paidBy],
    queryFn: (tok) => getCitizenProfile(tenant, tok, paidBy),
    tenant,
    base,
    token: otherPayer ? token : null,
    errorMessage: t('payerFileFailed'),
  });
  /** Whose file the receipt prints: the payer's, never another debtor's. Null while that file is being read. */
  const receiptCitizen = otherPayer ? (payerFile.data ?? null) : citizen;
  /** «سجّل الدفعة» waits for a payer, and for the file the receipt will name. */
  const payerBlocked = shared && (paidBy === '' || receiptCitizen === null);

  const [payIn, setPayIn] = useState<PayIn>('LBP');
  const [lbp, setLbp] = useState('');
  const [foreignRaw, setForeignRaw] = useState('');
  /** A rate typed for this payment only (finance roles); null means the municipality's. */
  const [rateOverride, setRateOverride] = useState<string | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RecordedMovement | null>(null);
  /**
   * One payment's receipt on a shared unit bill, reprinted from the receipts
   * below (decision D9): the payer's file and that payment alone — never the
   * bill's total under the file that happens to be open.
   */
  const [reprint, setReprint] = useState<{
    citizen: CitizenProfile;
    payment: CitizenProfilePayment;
    recorded: RecordedMovement;
  } | null>(null);
  const [reprintError, setReprintError] = useState<string | null>(null);
  /** A refusal said the key's payment exists, so the bill on screen was read before it. */
  const [billMoved, setBillMoved] = useState(false);
  /** …and reading it again failed: the balance shown is not the bill's, so nothing is judged against it. */
  const billStale = billMoved && Boolean(profile.error);
  /** «إلغاء الفاتورة» (finance audit B3): the manager's, on a bill nothing was paid on. */
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const tCancel = useTranslations('counterPayment.cancelBill');
  /*
    The shared contract decides the reason (`cancelBillSchema`, as the route
    validates it); its message is Arabic by design, so the words under the field
    are this page's, and they state the minimum.
  */
  const cancelInput = cancelBillSchema.safeParse({ reason: cancelReason });

  /*
    Double submission: `busy` disables the button after React re-renders, but
    a fast second press lands before that. The ref stops it synchronously.

    The retry key (STA-4, `keyIsSpent`) is held in `lib/request-id.ts` as
    `settle:<paymentId>`, the same key the counter settle page holds for this
    bill, so it outlives this page. It is kept across every failure and every
    edit: a refusal proves only that this attempt took nothing, never that an
    earlier one with the key did not. The server binds the key to its act
    (finance audit B6): this bill, the method and these notes. A retry after a
    lost answer that sends the same notes is answered with the first receipt,
    and the page says so (`replayed`); the rate is not compared, so its ليرة
    credit can differ from the preview when the official rate moved meanwhile,
    and the receipt prints the server's. A retry with other notes is refused
    (`PAYMENT_IDEMPOTENCY_KEY_REUSED`): the earlier payment was taken, so the
    key is spent and the bill is read again before the button is released.
    Once the server has answered with a 2xx the key is spent and the page is
    done: the receipt opens, and nothing here records again.
  */
  const inFlight = useRef(false);
  const keyScope = `settle:${paymentId}` as const;

  /** The municipality's second currency and its rate — the only pair the counter takes. */
  const foreignCurrency = settings?.secondaryCurrency === 'EUR' ? 'EUR' : 'USD';
  const foreignUnit = foreignCurrency === 'EUR' ? '€' : '$';
  const officialRate =
    settings?.secondaryCurrency === foreignCurrency && settings.exchangeRate ? settings.exchangeRate : null;
  const usesForeign = payIn !== 'LBP';
  const exchangeRate = roundRate(rateOverride !== null ? parseAmount(rateOverride) : (officialRate ?? 0));

  const local = payIn === 'FOREIGN' ? 0 : parseAmount(lbp);
  const foreign = payIn === 'LBP' ? 0 : parseAmount(foreignRaw);
  const remaining = payment ? payment.remaining : 0;
  // The server's arithmetic, shown before it is sent.
  const worth = Math.round(local + foreign * exchangeRate);
  const change = foreign > 0 && local <= remaining + 0.5 && worth > remaining + 0.5 ? Math.round(worth - remaining) : 0;
  const credit = change > 0 ? remaining : worth;
  const after = remaining - credit;
  const settlesIt = credit > 0 && Math.abs(after) <= 0.5;

  const rateOverridden = foreign > 0 && (officialRate === null || exchangeRate !== roundRate(officialRate));
  const backdatedDays = paidOn && paidOn < today ? daysBetween(paidOn, today) : 0;
  const needsReason = rateOverridden || backdatedDays > 0;

  const problem: string | null = (() => {
    if (usesForeign && exchangeRate <= 0) {
      return finance
        ? en
          ? `Enter the ${foreignCurrency} rate for this payment.`
          : 'أدخل سعر الصرف لهذه الدفعة.'
        : en
          ? `No official ${foreignCurrency} rate is set. Only the system administrator sets it, in Settings.`
          : 'لا يوجد سعر صرف معتمد. يحدّده مدير النظام وحده من الإعدادات.';
    }
    if (worth <= 0) return en ? 'Enter the amount paid.' : 'أدخل المبلغ المدفوع.';
    if (worth > remaining + 0.5 && change === 0) {
      return en
        ? `The pounds alone are ${formatLbp(worth - remaining, locale)} more than is owed.`
        : `المبلغ بالليرة يزيد عن المستحق بـ ${formatLbp(worth - remaining, locale)}.`;
    }
    if (!paidOn) return en ? 'Choose the payment date.' : 'اختر تاريخ الدفع.';
    if (backdatedDays > BACKDATE_WINDOW_DAYS && !finance) {
      return en
        ? `A payment more than ${BACKDATE_WINDOW_DAYS} days back is a correction for an accountant or the system administrator.`
        : `دفعة بتاريخ يسبق اليوم بأكثر من ${BACKDATE_WINDOW_DAYS} يوماً تصحيحٌ يعود للمحاسب أو مدير النظام.`;
    }
    if (needsReason && reason.trim().length < ADJUSTMENT_REASON_MIN) {
      return rateOverridden
        ? en
          ? 'Write why this payment is taken at another rate.'
          : 'اكتب سبب اعتماد سعر صرف غير السعر المعتمد.'
        : en
          ? 'Write why this payment is dated before today.'
          : 'اكتب سبب تسجيل الدفعة بتاريخ سابق.';
    }
    return null;
  })();

  /**
   * The whole balance in the chosen currency. In the foreign currency alone,
   * rounded up to the cent — the few ليرة over come back as change; with both,
   * whole cents in the foreign currency and the rest in ليرة, exactly.
   */
  const fillWhole = () => {
    if (payIn === 'LBP') {
      setLbp(formatTypedAmount(String(Math.round(remaining)), 0));
      return;
    }
    if (exchangeRate <= 0) return;
    if (payIn === 'FOREIGN') {
      setForeignRaw(formatTypedAmount(String(Math.ceil((remaining / exchangeRate) * 100) / 100), 2));
      return;
    }
    const whole = Math.floor((remaining / exchangeRate) * 100) / 100;
    const rest = Math.max(0, Math.round(remaining - whole * exchangeRate));
    setForeignRaw(formatTypedAmount(String(whole), 2));
    setLbp(rest > 0 ? formatTypedAmount(String(rest), 0) : '');
  };

  /** The words for a failed press: the localised text for the code (TXT-6), or this page's own for an earlier receipt. */
  const failureText = (caught: unknown): string => {
    if (caught instanceof ApiRequestError) {
      const number = caught.payload.params?.receiptNumber;
      if (number && caught.code === 'TRANSACTION_ALREADY_REVERSED') return t('earlierReversed', { number: String(number) });
      if (number && caught.code === 'PAYMENT_IDEMPOTENCY_KEY_REUSED') return t('earlierRecorded', { number: String(number) });
      return caught.message;
    }
    return en
      ? 'Could not record the payment. Nothing was taken twice — press again to retry.'
      : 'تعذّر تسجيل الدفعة. لن تُسجَّل مرتين — اضغط مجدداً لإعادة المحاولة.';
  };

  /**
   * «طباعة الوصل» on one payment of a shared unit bill (D9): the payer's own
   * file — read when it is not this one — and the receipt that payment wrote,
   * with what the bill still owed right after it (`receiptOfEntry`).
   */
  const printSharedReceipt = async (entry: PaymentLedgerEntry, entries: readonly PaymentLedgerEntry[]) => {
    if (!token || !payment || !entry.paidByCitizenId) return;
    setReprintError(null);
    try {
      const payer =
        entry.paidByCitizenId === citizenId && citizen
          ? citizen
          : await getCitizenProfile(tenant, token, entry.paidByCitizenId);
      const row = payer.payments.find((candidate) => candidate.id === payment.id);
      const recorded = receiptOfEntry(entries, entry.id, payment.amount);
      if (!row || !recorded) {
        setReprintError(t('reprintMissing'));
        return;
      }
      setReprint({ citizen: payer, payment: { ...row, remaining: recorded.remaining }, recorded });
    } catch (caught) {
      logApiError(caught);
      setReprintError(t('reprintFailed'));
    }
  };

  const submit = async () => {
    if (!token || !payment || problem || payerBlocked || receipt || billStale || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof settlePayment>>;
    try {
      result = await settlePayment(tenant, token, payment.id, {
        method: 'CASH',
        tendered: {
          local,
          foreign,
          foreignCurrency,
          // Omitted at the official rate, so the server takes its own figure.
          ...(rateOverridden ? { exchangeRate } : {}),
        },
        // Only when it was not today, so a same-day payment keeps its real time.
        ...(paidOn !== today ? { paidOn } : {}),
        ...(needsReason ? { adjustmentReason: reason.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        /*
          A shared unit bill (0099) is paid by one of its debtors, named: the one
          chosen above, this file's citizen unless the clerk chose another (the
          ledger checks they are one). Refused on any other bill.
        */
        ...(shared ? { paidByCitizenId: paidBy } : {}),
        clientRequestId: heldKey(tenant, keyScope),
      });
    } catch (caught) {
      logApiError(caught);
      setError(failureText(caught));
      // A key whose act exists is spent; every other failure keeps it, so a retry is answered from the first.
      if (keyIsSpent(caught)) {
        spendKey(tenant, keyScope);
        /*
          That payment was taken, so the balance on screen is from before it,
          and so is every treasury figure. The button stays held (`inFlight`,
          `busy`) until the bill is read again — and stays off after, while
          that read has failed (`billStale`) — so the next press is never
          judged against the old balance.
        */
        setBillMoved(true);
        void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
        await queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant, citizenId] });
      }
      inFlight.current = false;
      setBusy(false);
      return;
    }

    // Recorded: `inFlight` stays held and `receipt` keeps the button off, until the page moves on.
    spendKey(tenant, keyScope);
    setBusy(false);
    // The cash is in a wallet now, so every treasury balance read before it is stale.
    void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
    void queryClient.invalidateQueries({ queryKey: ['payment-transactions', tenant, paymentId] });
    if (result.replayed) {
      toast.warning(t('replayedTitle', { number: result.receiptNumber }), {
        description: t('replayedBody', { amount: formatLbp(result.received, locale) }),
      });
    }
    setReceipt({
      receiptNumber: result.receiptNumber,
      occurredAt: result.occurredAt,
      received: result.received,
      remaining: result.remaining,
      changeGiven: result.changeGiven,
      /*
        The notes handed over are this form's, which describe the first attempt
        only when this one recorded it. A replayed receipt prints none rather
        than notes that may not be the ones taken.
      */
      tender:
        foreign > 0 && !result.replayed
          ? {
              local,
              foreign,
              foreignCurrency,
              exchangeRate: result.exchangeRate ?? exchangeRate,
              officialExchangeRate: result.officialExchangeRate,
            }
          : null,
      // This movement's method, so the receipt does not print an earlier movement's.
      method: 'CASH',
    });
  };

  // Only a read that never answered replaces the page; a failed re-read leaves the form, and what was typed, in place.
  if (profile.error && !citizen) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <HeaderBackLink fallbackHref={citizenHref} label={en ? 'Back' : 'رجوع'} />
        <ErrorState
          description={profile.error}
          onRetry={() => void profile.refetch()}
          retryLabel={en ? 'Try again' : 'إعادة المحاولة'}
        />
      </div>
    );
  }
  if (!citizen) return <LoadingState fullHeight label={en ? 'Loading the bill…' : 'جارٍ تحميل الفاتورة…'} />;

  /** This payment, in the currency it is being made in. */
  const paidAs =
    [foreign > 0 ? formatForeign(foreign, foreignCurrency) : null, local > 0 ? formatLbp(local, locale) : null]
      .filter(Boolean)
      .join(' + ') || formatLbp(0, locale);

  const statusLabel = payment
    ? (labels.paymentStatus?.[payment.paymentStatus as never] ?? payment.paymentStatus)
    : null;
  /** Shown to the manager on an open bill with nothing paid on it; the server re-checks both. */
  const canCancel =
    Boolean(payment) &&
    !receipt &&
    hasRole(BILL_CANCEL_ROLES, user?.role) &&
    (payment?.paymentStatus === 'UNPAID' || payment?.paymentStatus === 'OVERDUE') &&
    (payment?.paidAmount ?? 0) === 0;

  /** The municipal request this bill is the fee of (0092); null for any other bill. */
  const linkedRequest = payment?.request ?? null;
  /** Cancelling the bill cancels the request while it is open (`cancelRequestOfCancelledBill`), so the dialog says so. */
  const requestOpen = linkedRequest?.status === 'AWAITING_PAYMENT' || linkedRequest?.status === 'IN_REVIEW';
  /** The request's panel in the queue, for a role that may read it. */
  const requestHref =
    linkedRequest && hasRole(REQUEST_READ_ROLES, user?.role)
      ? `${base}/requests?request=${encodeURIComponent(linkedRequest.id)}`
      : null;
  const requestCode = (number: string) => (
    <bdi dir="ltr" className="font-mono">
      {number}
    </bdi>
  );

  /** A refusal is thrown on: the dialog shows the server's coded words beside the action, and stays open. */
  const confirmCancel = async (): Promise<void> => {
    if (!token || !payment || !cancelInput.success) return;
    let result: CancelBillResult;
    try {
      result = await cancelBill(tenant, token, payment.id, cancelInput.data);
    } catch (caught) {
      logApiError(caught);
      throw caught;
    }
    // The server's answer names the request it cancelled, whatever this page read before the press.
    toast.success(
      result.cancelledRequest
        ? tCancel('doneWithRequest', { number: result.cancelledRequest.requestNumber })
        : tCancel('done'),
    );
    setCancelReason('');
    // The queue and its panel drop the request now, not when their cache next goes stale.
    void queryClient.invalidateQueries({ queryKey: ['requests', tenant] });
    await queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant, citizenId] });
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={citizenHref} label={en ? 'Back' : 'رجوع'} />

      {profile.error ? (
        <RefreshFailedAlert
          // After a refusal that said the bill moved, the button stays off until it is read (`billStale`).
          title={billStale ? t('billStale') : undefined}
          message={profile.error}
          onRetry={() => void profile.refetch()}
        />
      ) : null}

      {/*
        Who is paying, for what, and how much is left — the three things the
        clerk checks against the person at the counter before taking a note.
        Headers carry a title and nothing under it, so the bill and the payer
        are the title itself: this screen's only other place for them was the
        line that was removed, and a cash screen that does not say whose cash
        it is takes money from the wrong person. «رجوع» above still leads back
        to the citizen's file.
      */}
      <PageHeader
        icon={Banknote}
        title={
          payment
            ? `${payment.title} — ${citizen.fullName}`
            : en
              ? 'Record cash payment'
              : 'تسجيل دفعة نقدية'
        }
        actions={
          payment ? (
            <div className="text-end">
              <p className="text-xs font-medium text-muted-foreground">{en ? 'Outstanding' : 'المتبقي'}</p>
              <p className="text-2xl font-bold leading-tight tabular-nums">{formatLbp(remaining, locale)}</p>
              <p className="text-xs text-muted-foreground">
                {statusLabel} · {en ? 'due ' : 'استحقاق '}
                {formatDate(payment.dueDate)}
              </p>
            </div>
          ) : null
        }
      />

      {canCancel ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
            <Ban className="size-4" aria-hidden />
            {tCancel('action')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={tCancel('title')}
        description={tCancel('description')}
        confirmLabel={tCancel('confirm')}
        cancelLabel={tCancel('keep')}
        busyLabel={tCancel('busy')}
        confirmDisabled={!cancelInput.success}
        onConfirm={confirmCancel}
      >
        {requestOpen && linkedRequest ? (
          <Alert variant="warning">
            {tCancel.rich('requestWarning', {
              number: linkedRequest.requestNumber,
              type: labels.requestType[linkedRequest.requestType],
              code: (chunks) => (
                <bdi dir="ltr" className="font-mono">
                  {chunks}
                </bdi>
              ),
            })}
          </Alert>
        ) : null}
        {/* The minimum in the caption from the start; a reason typed short of it says so under the field. */}
        <Field
          label={tCancel('reason', { min: ADJUSTMENT_REASON_MIN })}
          htmlFor="cancel-bill-reason"
          required
          error={cancelReason && !cancelInput.success ? tCancel('reasonTooShort', { min: ADJUSTMENT_REASON_MIN }) : undefined}
        >
          <Textarea
            id="cancel-bill-reason"
            value={cancelReason}
            maxLength={500}
            placeholder={tCancel('reasonPlaceholder')}
            onChange={(event) => setCancelReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>

      {!payment ? (
        <EmptyState
          icon={ReceiptText}
          title={en ? 'This bill is not on the citizen’s file' : 'هذه الفاتورة غير موجودة في ملف المواطن'}
          description={en ? 'It may have been cancelled or merged. Open the file to see current bills.' : 'ربما أُلغيت أو دُمجت. افتح الملف لرؤية الفواتير الحالية.'}
          action={
            <Link href={citizenHref} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              {en ? 'Open the citizen file' : 'فتح ملف المواطن'}
            </Link>
          }
        />
      ) : payment.paymentStatus === 'CANCELLED' ? (
        <EmptyState
          icon={Ban}
          title={tCancel('cancelledTitle')}
          description={payment.cancellationReason ?? tCancel('cancelledBody')}
          action={
            linkedRequest && requestHref ? (
              <Link href={requestHref} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                {tCancel('openRequest')} {requestCode(linkedRequest.requestNumber)}
              </Link>
            ) : undefined
          }
        />
      ) : payment.paymentStatus === 'PAID' && !receipt ? (
        <EmptyState
          icon={Banknote}
          title={en ? 'This bill is already paid in full' : 'هذه الفاتورة مسدّدة بالكامل'}
          description={en ? 'Nothing is owed on it.' : 'لا مبلغ مستحقاً عليها.'}
        />
      ) : payment.currency !== 'LBP' && !receipt ? (
        /*
          This page takes ليرة and the municipality's second currency against a
          ليرة bill. A bill raised in another currency is settled in that
          currency, from the fees page's own settle screen.
        */
        <EmptyState
          icon={ReceiptText}
          title={en ? `This bill is in ${payment.currency}` : `هذه الفاتورة بعملة ${payment.currency}`}
          description={en ? 'Record its payment from the fees page.' : 'سجّل دفعتها من صفحة الرسوم.'}
          action={
            <Link
              href={settleHref}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {en ? 'Open it in fees' : 'فتحها في صفحة الرسوم'}
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* ── The form ──────────────────────────────────────────────── */}
          <Card>
            <CardContent className="flex flex-col gap-5 p-5">
              <div className="space-y-2">
                <h2 className="font-semibold">{en ? 'Paid in' : 'عملة الدفع'}</h2>
                <SegmentedControl
                  aria-label={en ? 'Paid in' : 'عملة الدفع'}
                  value={payIn}
                  onChange={(next) => {
                    setPayIn(next as PayIn);
                    if (next === 'LBP') setForeignRaw('');
                    if (next === 'FOREIGN') setLbp('');
                  }}
                  options={[
                    { value: 'LBP', label: en ? 'Lebanese pounds' : 'ليرة لبنانية' },
                    {
                      value: 'FOREIGN',
                      label: foreignCurrency === 'EUR' ? (en ? 'Euros' : 'يورو') : en ? 'US dollars' : 'دولار أميركي',
                    },
                    { value: 'BOTH', label: en ? 'Both' : `ليرة + ${foreignUnit}` },
                  ]}
                />
              </div>

              {/* The rate: the municipality's, shown not typed. A finance role may change it for one payment. */}
              {usesForeign ? (
                rateOverride === null && officialRate ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
                    <span>
                      <span className="text-muted-foreground">{en ? 'Official rate: ' : 'السعر المعتمد: '}</span>
                      <bdi dir="ltr" className="font-semibold tabular-nums">
                        1 {foreignUnit} = {formatLbp(officialRate, locale)}
                      </bdi>
                      {settings?.exchangeRateUpdatedAt ? (
                        <span className="ms-2 text-xs text-muted-foreground">
                          ({en ? 'set ' : 'حُدِّث '}
                          {formatDate(settings.exchangeRateUpdatedAt)})
                        </span>
                      ) : null}
                    </span>
                    {finance ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1.5"
                        onClick={() => setRateOverride(formatTypedAmount(String(officialRate), 4))}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                        {en ? 'Another rate for this payment' : 'سعر آخر لهذه الدفعة'}
                      </Button>
                    ) : null}
                  </div>
                ) : !finance ? (
                  settingsQuery.loading ? null : (
                    <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-sm text-warning">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>
                        {en
                          ? `No official ${foreignCurrency} rate is set, so this counter cannot take ${foreignCurrency}. Only the system administrator sets it, in Settings.`
                          : 'لا يوجد سعر صرف معتمد، فلا يمكن قبض العملة الأجنبية هنا. يحدّده مدير النظام وحده من الإعدادات.'}
                      </span>
                    </p>
                  )
                ) : (
                  <Field
                    label={
                      en
                        ? `Rate for this payment (LBP per 1 ${foreignUnit})`
                        : `سعر الصرف لهذه الدفعة (ليرة لكل 1 ${foreignUnit})`
                    }
                    htmlFor="tender-rate"
                    required
                    // A rate is a value the credit is computed from — what `caution` is for.
                    caution={
                      officialRate
                        ? en
                          ? `The official rate is ${formatLbp(officialRate, locale)}. Another rate is recorded with its reason and shown on the receipt.`
                          : `السعر المعتمد ${formatLbp(officialRate, locale)}. أي سعر آخر يُسجَّل مع سببه ويُطبع على الوصل.`
                        : en
                          ? 'No official rate is set; the rate you enter is recorded with its reason.'
                          : 'لا يوجد سعر معتمد؛ يُسجَّل السعر الذي تدخله مع سببه.'
                    }
                  >
                    <div className="flex gap-2">
                      <CurrencyInput
                        id="tender-rate"
                        unit="ل.ل"
                        value={rateOverride ?? ''}
                        onChange={(raw) => setRateOverride(formatTypedAmount(raw, 4))}
                        placeholder={en ? 'e.g. 89,500' : 'مثال: 89,500'}
                        className="flex-1"
                      />
                      {officialRate ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          title={en ? 'Back to the official rate' : 'العودة إلى السعر المعتمد'}
                          aria-label={en ? 'Back to the official rate' : 'العودة إلى السعر المعتمد'}
                          onClick={() => setRateOverride(null)}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </Field>
                )
              ) : null}

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">{en ? 'Amount' : 'المبلغ'}</h2>
                  <div className="flex flex-wrap gap-1.5">
                    <QuickButton icon={Coins} onClick={fillWhole} disabled={usesForeign && exchangeRate <= 0}>
                      {en ? 'Whole balance' : 'كامل المتبقي'}
                    </QuickButton>
                    <QuickButton
                      icon={Eraser}
                      onClick={() => {
                        setLbp('');
                        setForeignRaw('');
                      }}
                    >
                      {en ? 'Clear' : 'مسح'}
                    </QuickButton>
                  </div>
                </div>
                <div className={cn('grid gap-4', payIn === 'BOTH' && 'sm:grid-cols-2')}>
                  {payIn !== 'LBP' ? (
                    <Field label={en ? `In ${foreignCurrency}` : `بالـ${foreignUnit}`} htmlFor="tender-foreign" optionalLabel="">
                      <CurrencyInput
                        id="tender-foreign"
                        unit={foreignUnit}
                        value={foreignRaw}
                        onChange={(raw) => setForeignRaw(formatTypedAmount(raw, 2))}
                        placeholder={en ? 'e.g. 20' : 'مثال: 20'}
                        disabled={exchangeRate <= 0}
                      />
                      <Equivalent>
                        {foreign > 0 && exchangeRate > 0 ? `= ${formatLbp(Math.round(foreign * exchangeRate), locale)}` : null}
                      </Equivalent>
                    </Field>
                  ) : null}
                  {payIn !== 'FOREIGN' ? (
                    <Field label={en ? 'In Lebanese pounds' : 'بالليرة'} htmlFor="tender-lbp" optionalLabel="">
                      <CurrencyInput
                        id="tender-lbp"
                        unit="ل.ل"
                        value={lbp}
                        onChange={(raw) => setLbp(formatTypedAmount(raw, 0))}
                        placeholder={en ? 'e.g. 500,000' : 'مثال: 500,000'}
                      />
                      <Equivalent>
                        {local > 0 && exchangeRate > 0 ? `≈ ${formatForeign(local / exchangeRate, foreignCurrency)}` : null}
                      </Equivalent>
                    </Field>
                  ) : null}
                </div>
              </div>

              {/* Who is paying a shared unit bill (0099, D5): this file's citizen to start with, any debtor of the unit. */}
              {shared ? (
                bill.error && !debtors ? (
                  <ErrorState compact title={bill.error} onRetry={() => void bill.refetch()} retryLabel={t('payerRetry')} />
                ) : (
                  <div className="space-y-2">
                    <SharedBillPayerField
                      id="tender-payer"
                      debtors={debtors ?? []}
                      value={paidBy}
                      onChange={setPaidBy}
                      disabled={!debtors || busy || receipt !== null}
                    />
                    {otherPayer && payerFile.error && !payerFile.data ? (
                      <Alert variant="destructive" live="alert">
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          {payerFile.error}
                          <Button type="button" size="sm" variant="outline" onClick={() => void payerFile.refetch()}>
                            {t('payerRetry')}
                          </Button>
                        </span>
                      </Alert>
                    ) : null}
                  </div>
                )
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={en ? 'Payment date' : 'تاريخ الدفع'}
                  htmlFor="tender-date"
                  required
                >
                  <DatePicker id="tender-date" value={paidOn} onChange={setPaidOn} max={today} locale={en ? 'en' : 'ar'} />
                </Field>
                <Field label={en ? 'Note' : 'ملاحظة'} htmlFor="tender-note">
                  <Textarea
                    id="tender-note"
                    rows={1}
                    maxLength={500}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={en ? 'e.g. paid by his son at the counter' : 'مثال: دفعها ابنه على الشباك'}
                    className="min-h-10 resize-none"
                  />
                </Field>
              </div>

              {needsReason ? (
                <Field
                  label={
                    rateOverridden
                      ? en
                        ? 'Why another rate'
                        : 'سبب اعتماد سعر آخر'
                      : en
                        ? `Why it is dated ${backdatedDays} day${backdatedDays === 1 ? '' : 's'} before today`
                        : `سبب تسجيلها بتاريخ يسبق اليوم بـ ${backdatedDays} يوماً`
                  }
                  htmlFor="tender-reason"
                  required
                >
                  <Textarea
                    id="tender-reason"
                    rows={2}
                    maxLength={300}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={
                      en
                        ? 'e.g. collected on the round of 28 September, entered today'
                        : 'مثال: قُبضت في جولة 28 أيلول وأُدخلت اليوم'
                    }
                    className="resize-none"
                  />
                </Field>
              ) : null}
            </CardContent>
          </Card>

          {/* ── The summary, the button at its foot ── */}
          <Card>
            <CardContent className="flex h-full flex-col gap-4 p-5">
              <div>
                <h2 className="mb-1 font-semibold">{en ? 'The bill' : 'الفاتورة'}</h2>
                <SummaryList>
                  <SummaryRow label={en ? 'Due' : 'الاستحقاق'}>{formatDate(payment.dueDate)}</SummaryRow>
                  <SummaryRow label={en ? 'Status' : 'الحالة'}>{statusLabel}</SummaryRow>
                  {linkedRequest ? (
                    <SummaryRow label={tCancel('request')}>
                      {labels.requestType[linkedRequest.requestType]} ·{' '}
                      {requestHref ? (
                        <Link href={requestHref} className="text-primary underline-offset-4 hover:underline">
                          {requestCode(linkedRequest.requestNumber)}
                        </Link>
                      ) : (
                        requestCode(linkedRequest.requestNumber)
                      )}{' '}
                      · {labels.requestStatus[linkedRequest.status]}
                    </SummaryRow>
                  ) : null}
                  <SummaryRow label={en ? 'Billed' : 'قيمة الفاتورة'} className="tabular-nums">
                    {formatLbp(payment.amount, locale)}
                  </SummaryRow>
                  {payment.paidAmount > 0 ? (
                    <SummaryRow label={en ? 'Paid so far' : 'المسدَّد سابقاً'} className="tabular-nums">
                      {formatLbp(payment.paidAmount, locale)}
                    </SummaryRow>
                  ) : null}
                  <SummaryRow label={en ? 'Outstanding' : 'المتبقي'} className="tabular-nums">
                    {formatLbp(remaining, locale)}
                  </SummaryRow>
                </SummaryList>
              </div>

              <div className="rounded-lg bg-muted/50 px-3">
                <SummaryList>
                  <SummaryRow label={en ? 'Handed over' : 'المبلغ المستلم'} className="tabular-nums">
                    <span className="flex flex-col items-end">
                      <span>{paidAs}</span>
                      {foreign > 0 && worth > 0 ? (
                        <span className="text-xs font-normal text-muted-foreground">= {formatLbp(worth, locale)}</span>
                      ) : null}
                    </span>
                  </SummaryRow>
                  {change > 0 ? (
                    <SummaryRow label={en ? 'Change to hand back' : 'الباقي للمواطن'} className="tabular-nums text-info">
                      {formatLbp(change, locale)}
                    </SummaryRow>
                  ) : null}
                  <SummaryRow
                    label={en ? 'Left after it' : 'المتبقي بعدها'}
                    className={cn('tabular-nums', settlesIt && 'text-success')}
                  >
                    {settlesIt ? (en ? 'Paid in full' : 'مسدّدة بالكامل') : formatLbp(Math.max(after, 0), locale)}
                  </SummaryRow>
                  <SummaryRow label={en ? 'Paid on' : 'تاريخ الدفع'}>
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden />
                      {paidOn ? formatDate(paidOn) : '—'}
                    </span>
                  </SummaryRow>
                </SummaryList>
              </div>

              {problem && (worth > 0 || (usesForeign && exchangeRate <= 0 && !settingsQuery.loading)) ? (
                <p role="alert" className="text-sm text-destructive">
                  {problem}
                </p>
              ) : null}
              {error ? (
                <Alert variant="destructive" live="alert">
                  {error}
                </Alert>
              ) : null}

              <div className="mt-auto space-y-2">
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => void submit()}
                  disabled={busy || Boolean(problem) || payerBlocked || receipt !== null || billStale}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Banknote className="size-4" aria-hidden />}
                  {en ? 'Record payment' : 'سجّل الدفعة'}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => router.push(citizenHref)} disabled={busy}>
                  {en ? 'Cancel' : 'إلغاء'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* The receipt, straight after; closing it goes back to the citizen's file. */}
          <PaymentReceipt
            open={receipt !== null}
            onOpenChange={(open) => {
              if (!open) router.push(citizenHref);
            }}
            tenant={tenant}
            // Only the money roles reach this page, and each of them may send a citizen their reference.
            canSend
            locale={locale}
            // The payer's file on a shared unit bill (`receiptCitizen`), loaded before the press could be made.
            citizen={receiptCitizen ?? citizen}
            payment={receipt ? { ...payment, remaining: receipt.remaining } : null}
            recorded={receipt}
            municipalityName={municipalityName}
            governorate={settings?.governorate}
            councilDecisionRef={settings?.councilDecisionRef}
            district={settings?.district}
            contactPhone={settings?.contactPhone}
            officeWhatsapp={settings?.whatsappNumber}
          />
        </div>
      )}

      {/*
        Every receipt on the bill, paid or not; «عكس الوصل» for the manager,
        unless a transfer the citizen reported waits for a clerk (the status
        decides). A paid bill's row on the citizen file links here for these.
      */}
      {payment ? (
        <BillReceipts
          tenant={tenant}
          base={base}
          token={token}
          role={user?.role}
          locale={locale}
          citizenId={citizenId}
          paymentId={payment.id}
          paymentStatus={payment.paymentStatus}
          // A shared unit bill's receipts are printed one payment at a time, each naming its payer (D9).
          onPrint={payment.sharedUnit ? (entry, entries) => void printSharedReceipt(entry, entries) : undefined}
        />
      ) : null}

      {reprintError ? (
        <Alert variant="destructive" live="alert">
          {reprintError}
        </Alert>
      ) : null}

      {reprint ? (
        <PaymentReceipt
          open
          onOpenChange={(open) => {
            if (!open) setReprint(null);
          }}
          tenant={tenant}
          // Only the money roles reach this page, and each of them may send a citizen their reference.
          canSend
          locale={locale}
          citizen={reprint.citizen}
          payment={reprint.payment}
          recorded={reprint.recorded}
          municipalityName={municipalityName}
          governorate={settings?.governorate}
          councilDecisionRef={settings?.councilDecisionRef}
          district={settings?.district}
          contactPhone={settings?.contactPhone}
          officeWhatsapp={settings?.whatsappNumber}
        />
      ) : null}
    </div>
  );
}

/** The other currency's worth of a field, under it — kept a line tall so the fields beside it do not jump. */
function Equivalent({ children }: { children: ReactNode }) {
  return <p className="mt-1 h-4 text-xs tabular-nums text-muted-foreground">{children}</p>;
}

function QuickButton({
  icon: Icon,
  onClick,
  disabled,
  children,
}: {
  icon: typeof Coins;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onClick} disabled={disabled}>
      <Icon className="size-3.5" aria-hidden />
      {children}
    </Button>
  );
}
