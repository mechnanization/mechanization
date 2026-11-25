'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  createTransferSchema,
  exchangeRateOf,
  judgeExchange,
  municipalToday,
  type TransferKind,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  createTransfer,
  logApiError,
  type CreateTransferResult,
  type TreasuryAccountView,
  type TreasuryRate,
} from '@/lib/api-client';
import { formatTypedAmount, parseAmount } from '@/lib/currency';
import {
  heldInDoubt,
  heldKey,
  keyIsSpent,
  markInDoubt,
  outcomeInDoubt,
  spendKey,
  type KeyScope,
} from '@/lib/request-id';
import { useToast } from '@/components/ui/toast';
import { decimalsOf, roundTo } from './figures';

/** The one scope this form's retry key is held under: one transfer at a time from this screen. */
const TRANSFER_SCOPE: KeyScope = 'transfer:new';

/** What the act is given; where «إلغاء» goes and the page's language are the form's own. */
export interface RecordTransferProps {
  tenant: string;
  token: string;
  /** The working wallets: the overview's, which leaves custody out. */
  accounts: TreasuryAccountView[];
  rate: TreasuryRate;
  onRecorded: () => void;
  /** Opens the transfer just written, to print: the success toast's action. */
  onPrint: (transferId: string) => void;
}

/**
 * The state of a transfer or an exchange and the one press that moves the money:
 * what is typed, what it will leave in each wallet, the checks made before the
 * round trip, the in-flight ref and the retry key `transfer:new`. The rules it
 * keeps are set out on `RecordTransferForm`; the fields that draw it are beside
 * this file.
 */
export function useRecordTransfer({
  tenant,
  token,
  accounts,
  rate,
  onRecorded,
  onPrint,
}: RecordTransferProps) {
  const t = useTranslations('finance.transfers.form');
  const queryClient = useQueryClient();
  const toast = useToast();

  const wallets = useMemo(() => accounts.filter((account) => account.active), [accounts]);
  const today = municipalToday();

  const [kind, setKind] = useState<TransferKind>('SAME_CURRENCY');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState('');
  const [quotedRate, setQuotedRate] = useState('');
  const [fee, setFee] = useState('');
  const [changer, setChanger] = useState('');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [transferredOn, setTransferredOn] = useState(today);
  const [backdateReason, setBackdateReason] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server has answered with a 2xx: the act is recorded, and the form stays locked. */
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  /*
    The retry key (STA-4, `keyIsSpent`) is held in `lib/request-id.ts` under
    `TRANSFER_SCOPE`, not here, so it outlives this form: a failed background
    re-read or a trip to the register and back unmounts it, and a key that died
    with it moved the money a second time. Kept across every failure and every
    edit — a refusal proves only that this attempt wrote nothing, never that an
    earlier one with the key did not. An edit made after an answer was lost is
    caught by the server, which binds the key to the wallets, the amounts, the
    fee and the statement (`TREASURY_REQUEST_KEY_REUSED`). Spent only when the
    server says its act exists.
  */
  /**
   * An earlier press under the held key got no answer: the balances on screen
   * may already carry it, so a check made here must not refuse the retry the
   * server would answer from the key. Read on each render; every press that
   * changes it also sets state.
   */
  const retrying = heldInDoubt(tenant, TRANSFER_SCOPE);

  const from = wallets.find((account) => account.id === fromId);
  const to = wallets.find((account) => account.id === toId);
  const backdated = transferredOn < today;

  /* The destinations this kind allows from this source: one currency for a transfer, the other for an exchange. */
  const destinations = wallets.filter(
    (account) =>
      account.id !== fromId &&
      (!from || (kind === 'SAME_CURRENCY' ? account.currency === from.currency : account.currency !== from.currency)),
  );

  const typedAmount = parseAmount(amount);
  const typedFee = parseAmount(fee);
  const typedReceived = kind === 'EXCHANGE' ? parseAmount(received) : typedAmount;
  const leaving = typedAmount + typedFee;
  const sourceAfter = from ? roundTo(from.balance - leaving, from.currency) : 0;
  const destinationAfter = to ? roundTo(to.balance + typedReceived, to.currency) : 0;
  const short = Boolean(from) && leaving > 0 && sourceAfter < 0;

  const legs =
    kind === 'EXCHANGE' && from && to && typedAmount > 0 && typedReceived > 0
      ? exchangeRateOf({
          fromCurrency: from.currency,
          toCurrency: to.currency,
          amount: typedAmount,
          receivedAmount: typedReceived,
          baseCurrency: rate.baseCurrency,
        })
      : null;
  const judgement = legs
    ? judgeExchange({
        rate: legs.rate,
        foreignAmount: legs.foreignAmount,
        officialRate: rate.exchangeRate,
        tolerancePercent: rate.tolerancePercent,
        largeThreshold: rate.largeExchangeThreshold,
      })
    : null;

  /** Received from the quoted rate: base per unit of the other side, whichever way the money goes. */
  const receivedFromRate = (sold: number, quoted: number): string => {
    if (!from || !to || sold <= 0 || quoted <= 0) return received;
    const value = to.currency === rate.baseCurrency ? sold * quoted : sold / quoted;
    return formatTypedAmount(String(roundTo(value, to.currency)), decimalsOf(to.currency));
  };

  const changeKind = (next: TransferKind): void => {
    setKind(next);
    setToId('');
    setReceived('');
    setQuotedRate('');
    setErrors({});
  };

  /** Re-reads the treasury figures: the balances the summary checks against, and the register. */
  const refreshFigures = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });

  /**
   * The words for a failed press. Already the localised text for the code
   * (TXT-6), except where this form knows more: an earlier press recorded and
   * cancelled since is answered with `TRANSFER_ALREADY_VOID`, which on its own
   * reads as a refusal to cancel.
   */
  const failureText = (caught: unknown): string => {
    if (caught instanceof ApiRequestError && caught.code === 'TRANSFER_ALREADY_VOID') {
      const number = caught.payload.params?.transferNumber;
      if (number) return t('errors.earlierVoided', { number: String(number) });
    }
    return caught instanceof Error && caught.message ? caught.message : t('errors.form');
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current || done) return;

    const base = {
      fromAccountId: fromId,
      toAccountId: toId,
      amount: typedAmount,
      feeAmount: typedFee > 0 ? typedFee : undefined,
      description,
      transferredOn,
      backdateReason: backdated ? backdateReason.trim() || undefined : undefined,
      clientRequestId: heldKey(tenant, TRANSFER_SCOPE),
    };
    const parsed = createTransferSchema.safeParse(
      kind === 'SAME_CURRENCY'
        ? { kind, ...base }
        : {
            kind,
            ...base,
            receivedAmount: typedReceived,
            moneyChangerName: changer.trim() || undefined,
            adjustmentReason: reason.trim() || undefined,
          },
    );

    const next: Record<string, string> = {};
    if (!parsed.success) {
      /*
        The shared schema is the contract and its messages are Arabic by
        design, so only the field names come from it; the words are this
        screen's (TXT-1).
      */
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        if (!next[field]) next[field] = t(`errors.${field === 'clientRequestId' || field === 'kind' ? 'form' : field}`);
      }
    }
    /*
      What the server refuses, said before the round trip — except for the
      retry of a press whose answer was lost: the balance read since may carry
      that very transfer, and the official rate may have moved, while the server
      answers a replay before it judges either.
    */
    if (short && !retrying && !next.amount) next.amount = t('errors.short');
    if (judgement?.beyondTolerance && !retrying && !reason.trim()) {
      next.adjustmentReason = t('errors.adjustmentReason');
    }
    if (backdated && !backdateReason.trim()) next.backdateReason = t('errors.backdateReason');

    if (!parsed.success || Object.keys(next).length > 0) {
      setErrors(next);
      setFormError(null);
      // Put the officer on the first thing to fix (FRM-2).
      const order = ['fromAccountId', 'toAccountId', 'amount', 'receivedAmount', 'feeAmount', 'adjustmentReason', 'description', 'backdateReason'];
      const first = order.find((field) => next[field]);
      document.getElementById(`transfer-${first ?? 'amount'}`)?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    let result: CreateTransferResult;
    try {
      result = await createTransfer(tenant, token, parsed.data);
    } catch (caught) {
      logApiError(caught);
      setFormError(failureText(caught));
      if (keyIsSpent(caught)) {
        // That act exists: the next press is a new one, and the figures on screen are behind it.
        spendKey(tenant, TRANSFER_SCOPE);
        void refreshFigures();
      } else if (outcomeInDoubt(caught)) {
        /*
          It may have been recorded. Re-read, so the summary is not the one from
          before the lost answer; the key is kept, so a retry of the same act is
          answered from it rather than moving the money again. Marked in doubt,
          so the shortage that re-read may now show does not refuse that retry.
        */
        markInDoubt(tenant, TRANSFER_SCOPE);
        void refreshFigures();
      }
      // A failed attempt releases the button; a recorded one never does.
      inFlight.current = false;
      setBusy(false);
      return;
    }

    /*
      Recorded. The form stays locked from here — `inFlight` is never released
      and `done` disables the button — until the page moves on: a page stays
      mounted until the next route is ready, and a second press here would be a
      second act under a new key.
    */
    setDone(true);
    setBusy(false);
    spendKey(tenant, TRANSFER_SCOPE);
    await refreshFigures();
    const print = { label: t('print'), onClick: () => onPrint(result.id) };
    if (result.replayed) {
      // An earlier press recorded it and its answer was lost: that transfer stands, as first recorded.
      toast.warning(t('replayed', { number: result.transferNumber }), { description: t('replayedBody'), action: print });
    } else {
      // The server's numbers, never a client-side reconstruction (STA-6).
      toast.success(t('success', { number: result.transferNumber }), {
        description: result.requiresReview
          ? t('successFlagged')
          : result.feeVoucherNumber
            ? t('successFee', { number: result.feeVoucherNumber })
            : t('successBody'),
        action: print,
      });
    }
    onRecorded();
  };

  const clear = (field: string) => setErrors(({ [field]: _cleared, ...rest }) => rest);

  return {
    wallets,
    today,
    kind,
    changeKind,
    fromId,
    setFromId,
    toId,
    setToId,
    amount,
    setAmount,
    received,
    setReceived,
    quotedRate,
    setQuotedRate,
    fee,
    setFee,
    changer,
    setChanger,
    reason,
    setReason,
    description,
    setDescription,
    transferredOn,
    setTransferredOn,
    backdateReason,
    setBackdateReason,
    errors,
    clear,
    formError,
    busy,
    done,
    retrying,
    from,
    to,
    backdated,
    destinations,
    typedAmount,
    typedReceived,
    leaving,
    sourceAfter,
    destinationAfter,
    short,
    legs,
    judgement,
    receivedFromRate,
    submit,
  };
}

/** What the field components are handed: the hook's answer, whole. */
export type RecordTransferState = ReturnType<typeof useRecordTransfer>;
