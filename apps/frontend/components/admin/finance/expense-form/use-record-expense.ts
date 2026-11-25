'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  recordExpenseSchema,
  requestExpenseSchema,
  municipalToday,
  TREASURY_ADMIN_ROLES,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  recordExpense,
  requestExpense,
  logApiError,
  type ExpenseCategoryView,
  type RecordExpenseInput,
  type RecordExpenseResult,
  type RequestExpenseInput,
  type RequestExpenseResult,
  type TreasuryAccountView,
} from '@/lib/api-client';
import { formatMoney, parseAmount } from '@/lib/currency';
import { firstFieldToFix, formCategories, isExpenseField } from '@/lib/expense-form';
import { expenseModeFor, paysNow, type ExpenseMode } from '@/lib/expense-order';
import {
  heldInDoubt,
  heldKey,
  keyIsSpent,
  markInDoubt,
  outcomeInDoubt,
  spendKey,
  type KeyScope,
} from '@/lib/request-id';
import { hasRole } from '@/lib/staff-roles';
import type { MovementDraft } from '@/lib/treasury-movements';

/**
 * What the form did, for the composer to say next: a voucher was paid, or a
 * request went to the head of the municipality.
 */
export type RecordOutcome =
  | { kind: 'PAID'; result: RecordExpenseResult }
  | { kind: 'REQUESTED'; result: RequestExpenseResult };

/** What the form is given; «مسح» is the form's own, the rest is the act's. */
export interface RecordExpenseProps {
  tenant: string;
  token: string;
  locale: string;
  role: string | undefined;
  accounts: TreasuryAccountView[];
  categories: ExpenseCategoryView[];
  /**
   * The manager's urgent-payment ceiling per currency (`LBP`, `USD`), `null`
   * for none; absent while the settings have not been read, when the server's
   * refusal is the only check.
   */
  urgentCeilings?: Partial<Record<string, number | null>>;
  /** What the clerk had typed on the «قبض» side before switching here. */
  initial?: Partial<MovementDraft>;
  /** Fires as the shared fields change, so a switch to «قبض» keeps them. */
  onDraftChange?: (draft: MovementDraft) => void;
  /** The voucher or the request is written; the composer mounts a fresh form for the next one. */
  onRecorded: (outcome: RecordOutcome) => void;
}

/**
 * The state of «صرف» and the one press that moves money: what is typed, what
 * the mode makes of it, the checks made before the round trip, the in-flight ref
 * and the retry keys `expense:pay` and `expense:request`. The rules it keeps are
 * set out on `RecordExpenseForm`; the fields that draw it are beside this file.
 */
export function useRecordExpense({
  tenant,
  token,
  locale,
  role,
  accounts,
  categories,
  urgentCeilings,
  initial,
  onDraftChange,
  onRecorded,
}: RecordExpenseProps) {
  const t = useTranslations('finance.expenses.form');
  const queryClient = useQueryClient();

  const today = municipalToday();
  /** What an accountant chose; the manager has nothing to choose (`expenseModeFor`). */
  const [choice, setChoice] = useState<Exclude<ExpenseMode, 'ORDER'>>('REQUEST');
  const mode = expenseModeFor(role, choice);
  const pays = paysNow(mode);

  const carried = initial?.accountId;
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState(
    carried && accounts.some((account) => account.id === carried) ? carried : (accounts[0]?.id ?? ''),
  );
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [payee, setPayee] = useState(initial?.party ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [paidOn, setPaidOn] = useState(today);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [urgentReason, setUrgentReason] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [hasPhysicalReceipt, setHasPhysicalReceipt] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** The server refused the urgent payment as above the ceiling: offer the request instead. */
  const [refusedOverCeiling, setRefusedOverCeiling] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The server has answered with a 2xx: the act is recorded, and the form stays locked. */
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    onDraftChange?.({ amount, accountId, party: payee, description });
  }, [onDraftChange, amount, accountId, payee, description]);

  /*
    The retry keys (STA-4, `keyIsSpent`), held in `lib/request-id.ts` rather
    than here, so they outlive this form: a background re-read that failed, or
    a switch to «قبض» and back, unmounts it, and a key that died with it paid a
    second time. Kept across every failure and every edit: a refusal proves
    only that this attempt wrote nothing, never that an earlier one with the
    key did not. An edit made after an answer was lost is caught by the server,
    which binds the key to the wallet, the amount, the band, the payee and the
    reason, and refuses it (`TREASURY_REQUEST_KEY_REUSED`) instead of paying a
    second time. A key is spent only when the server says its act exists.

    One scope per route, because they are two acts: a request is filed, a
    payment is made, and a retry of the one must never be answered as the other.
  */
  const scope = (forMode: ExpenseMode): KeyScope => (forMode === 'REQUEST' ? 'expense:request' : 'expense:pay');

  /** Bands added without leaving the form, so the select shows them at once. */
  const [added, setAdded] = useState<ExpenseCategoryView[]>([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const canManageCategories = hasRole(TREASURY_ADMIN_ROLES, role);

  const account = accounts.find((candidate) => candidate.id === accountId);
  const backdated = pays && paidOn < today;

  const typed = parseAmount(amount);
  const spending = Number.isFinite(typed) && typed > 0 ? typed : 0;
  /** A request moves no money, so there is nothing for it to overdraw. */
  const short = pays && Boolean(account) && spending > 0 && (account?.balance ?? 0) - spending < 0;

  /**
   * The ceiling that holds this voucher: the urgent path only, in the wallet's
   * currency. Equal to it is under it, as the server judges (`urgentCeilingBreached`).
   */
  const ceiling = mode === 'URGENT' && account ? (urgentCeilings?.[account.currency] ?? null) : null;
  const overCeiling = ceiling !== null && spending > ceiling;
  /**
   * An urgent press under the held payment key got no answer: the ceiling as
   * this screen read it may not refuse the retry. Read on each render; every
   * press that changes it also sets state.
   */
  const retrying = mode === 'URGENT' && heldInDoubt(tenant, scope(mode));
  const refusesOverCeiling = overCeiling && !retrying;
  const ceilingText = ceiling !== null && account ? formatMoney(ceiling, account.currency, locale) : '';

  /*
    Deduplicated by id: a band added here is in `added`, and arrives again from
    the list. Never «تعويضات المسح والجباية», which «صرف عمولة» alone pays.
  */
  const allCategories = useMemo(() => formCategories(categories, added), [categories, added]);

  /** What a failure with nothing better to say reads, for the act this press would be. */
  const failedText = t(mode === 'REQUEST' ? 'errors.requestForm' : 'errors.form');

  /**
   * Re-reads the treasury figures — the balances on the wallets, the register,
   * the queue — but not the band list under the open select: refetching that
   * list while the select is mounted is what dropped its value (see the select
   * in `voucher-fields.tsx`).
   */
  const refreshFigures = (): Promise<void> =>
    queryClient.invalidateQueries({
      queryKey: ['treasury', tenant],
      predicate: (query) => query.queryKey[2] !== 'expense-categories',
    });

  /**
   * The words for a failed press. Already the localised text for the code
   * (TXT-6), except where this form knows more than the code does: an earlier
   * press from this form that was recorded and then cancelled is answered with
   * `EXPENSE_ALREADY_VOID`, which on its own reads as a refusal to cancel.
   */
  const failureText = (error: unknown): string => {
    if (error instanceof ApiRequestError && error.code === 'EXPENSE_ALREADY_VOID') {
      const number = error.payload.params?.voucherNumber;
      if (number) return t('errors.earlierVoided', { number: String(number) });
    }
    /*
      The ceiling the server judged by — it may be newer than the one this
      screen read — written with the currency's own unit rather than its code.
    */
    if (error instanceof ApiRequestError && error.code === 'EXPENSE_URGENT_OVER_CEILING') {
      const { ceiling: limit, currency } = error.payload.params ?? {};
      if (typeof limit === 'number' && typeof currency === 'string') {
        return t('ceiling.refused', { ceiling: formatMoney(limit, currency, locale) });
      }
    }
    return error instanceof Error && error.message ? error.message : failedText;
  };

  /** Switching how it is paid keeps everything typed and drops only the complaints about the old way. */
  const choose = (next: Exclude<ExpenseMode, 'ORDER'>): void => {
    setChoice(next);
    setErrors({});
    setFormError(null);
    setRefusedOverCeiling(false);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current || done) return;

    const shared = {
      categoryId,
      accountId,
      amount: parseAmount(amount),
      payee,
      description,
      invoiceNumber: invoiceNumber.trim() || undefined,
      hasPhysicalReceipt,
    };
    /*
      The shared schema is the contract, and its messages are Arabic by
      design, so only the field names come from it and the words from this
      screen's own messages (TXT-1).
    */
    let request: RequestExpenseInput | null = null;
    let payment: RecordExpenseInput | null = null;
    let issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> = [];
    if (mode === 'REQUEST') {
      const parsed = requestExpenseSchema.safeParse({ ...shared, clientRequestId: heldKey(tenant, scope('REQUEST')) });
      if (parsed.success) request = parsed.data;
      else issues = parsed.error.issues;
    } else {
      const parsed = recordExpenseSchema.safeParse({
        ...shared,
        paidOn,
        adjustmentReason: adjustmentReason.trim() || undefined,
        // The manager's recording is the order; only an accountant paying first says why.
        urgentReason: mode === 'URGENT' ? urgentReason : undefined,
        clientRequestId: heldKey(tenant, scope(mode)),
      });
      if (parsed.success) payment = parsed.data;
      else issues = parsed.error.issues;
    }

    if (!request && !payment) {
      const next: Record<string, string> = {};
      for (const issue of issues) {
        const field = String(issue.path[0] ?? '');
        if (isExpenseField(field) && !next[field]) next[field] = t(`errors.${field}`);
      }
      setErrors(next);
      // An issue on nothing the officer can edit would otherwise fail without a word.
      setFormError(Object.keys(next).length === 0 ? failedText : null);
      // Put the officer on the first thing to fix rather than leaving them to hunt (FRM-2).
      const target = firstFieldToFix(next);
      if (target) document.getElementById(target)?.focus();
      return;
    }
    // The server asks for a reason on any back-dated voucher; say so before the round trip.
    if (backdated && !adjustmentReason.trim()) {
      setErrors({ adjustmentReason: t('errors.adjustmentReason') });
      document.getElementById('expense-adjustment')?.focus();
      return;
    }
    /*
      Above the manager's ceiling the urgent path is closed; the form offers the
      request instead. Not for the retry of a lost press: the server answers that.
    */
    if (refusesOverCeiling) {
      setErrors({ amount: t('ceiling.overField', { ceiling: ceilingText }) });
      document.getElementById('expense-amount')?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    setRefusedOverCeiling(false);
    inFlight.current = true;
    setBusy(true);
    let filed: RequestExpenseResult | null = null;
    let paid: RecordExpenseResult | null = null;
    try {
      if (request) filed = await requestExpense(tenant, token, request);
      else if (payment) paid = await recordExpense(tenant, token, payment);
    } catch (error) {
      logApiError(error);
      setFormError(failureText(error));
      setRefusedOverCeiling(error instanceof ApiRequestError && error.code === 'EXPENSE_URGENT_OVER_CEILING');
      if (keyIsSpent(error)) {
        // That act exists: the next press is a new one, and the register on screen is behind it.
        spendKey(tenant, scope(mode));
        void refreshFigures();
      } else if (outcomeInDoubt(error)) {
        /*
          It may have been recorded. Re-read, so the balance the wallets show
          is not the one from before the lost answer; the key is kept, so a
          retry of the same act is answered from it rather than paid again.
          Marked in doubt, so a ceiling lowered since does not refuse that retry.
        */
        markInDoubt(tenant, scope(mode));
        void refreshFigures();
      }
      // A failed attempt releases the button; a recorded one never does.
      inFlight.current = false;
      setBusy(false);
      return;
    }

    /*
      Recorded. This form stays locked from here — `inFlight` is never released
      and `done` disables the button — and the composer replaces it with a
      fresh one: a second press on this one would be a second act.
    */
    setDone(true);
    setBusy(false);
    // The act is confirmed: the next one in this scope gets a new key.
    spendKey(tenant, scope(mode));
    await refreshFigures();
    /*
      What the server says it recorded, not what this screen meant to ask for
      (STA-6) — said by the composer above the next entry: a request sent or one
      an earlier press had sent (`replayed`), a voucher paid, paid before the
      order (`AWAITING_ORDER`), or paid by an earlier press whose answer was lost.
    */
    if (filed) onRecorded({ kind: 'REQUESTED', result: filed });
    else if (paid) onRecorded({ kind: 'PAID', result: paid });
  };

  return {
    today,
    choice,
    mode,
    pays,
    categoryId,
    setCategoryId,
    accountId,
    setAccountId,
    amount,
    setAmount,
    payee,
    setPayee,
    description,
    setDescription,
    paidOn,
    setPaidOn,
    adjustmentReason,
    setAdjustmentReason,
    urgentReason,
    setUrgentReason,
    invoiceNumber,
    setInvoiceNumber,
    hasPhysicalReceipt,
    setHasPhysicalReceipt,
    errors,
    formError,
    refusedOverCeiling,
    busy,
    done,
    added,
    setAdded,
    addingCategory,
    setAddingCategory,
    canManageCategories,
    account,
    backdated,
    spending,
    short,
    ceiling,
    overCeiling,
    retrying,
    refusesOverCeiling,
    ceilingText,
    allCategories,
    choose,
    submit,
  };
}

/** What the field components are handed: the hook's answer, whole. */
export type RecordExpenseState = ReturnType<typeof useRecordExpense>;
