import { municipalToday, type PaymentMethod } from '@mechanization/shared-schemas';

/**
 * Where a citizen payment's money lands in the treasury — the rules, with no I/O.
 * Design: docs/finance.md §3.3 and §3.4.
 *
 * A payment's amount is a credit against an invoice in the invoice's currency.
 * What moved between the wallets is the notes that changed hands: a
 * 1,500,000 ل.ل bill paid with a $20 note and handed back in ليرة is +$20 in
 * one wallet and the change out of another, never "+1.5M ل.ل".
 */

/** A wallet, named by what it is rather than by id (the service resolves the id). */
export type WalletTarget =
  /** The municipality's primary account of this type and currency. */
  | { kind: 'PRIMARY'; type: 'CASH_SAFE' | 'WHISH_ACCOUNT'; currency: string }
  /** The cash a collector holds, in this currency. */
  | { kind: 'CUSTODY'; ownerId: string; currency: string };

/** Signed: positive is money into the wallet, negative is money out. */
export interface WalletLeg {
  target: WalletTarget;
  amount: number;
}

export interface PaymentMovement {
  method: PaymentMethod;
  /** The invoice's currency. */
  invoiceCurrency: string;
  /** The credit applied to the invoice, in `invoiceCurrency`. */
  amount: number;
  /** The notes as handed over, on a cash payment that recorded them. */
  tendered?: {
    local: number;
    foreign: number | null;
    foreignCurrency: string | null;
  } | null;
  /** Handed back to the citizen, in `invoiceCurrency`. */
  changeGiven: number;
  /** The collector who holds the cash, on a COLLECTOR payment. */
  collectedById: string | null;
}

/** Two decimals, and whole units for ليرة — the precision the ledger keeps. */
export function roundMoney(value: number, currency: string): number {
  return currency === 'LBP' ? Math.round(value) : Math.round(value * 100) / 100;
}

/**
 * Whether a payment credits a wallet at all.
 *
 * Only a payment taken at or after the go-live moment does. Cash taken before
 * it is already inside an opening balance, and crediting it again would count
 * it twice. `goLiveAt` null means the treasury is not active: nothing credits.
 *
 * A dated payment's moment comes from `documentOccurredAt`, which never puts a
 * go-live-day document before the opening entry. So by date the rule is the one
 * an expense follows (`planExpenseDate`): a day before go-live is not live, and
 * the go-live day itself is, whatever the hour of activation.
 */
export function creditsWallets(goLiveAt: Date | null, occurredAt: Date): boolean {
  return goLiveAt !== null && occurredAt.getTime() >= goLiveAt.getTime();
}

/**
 * The instant a receipt or a voucher dated `day` is recorded at.
 *
 * - Today: the real clock time, so the day's movements read in the order they
 *   happened.
 * - An earlier day: midday UTC of it — 14:00 or 15:00 in Beirut — so no zone
 *   the reports are read in moves it off its day.
 * - On the go-live day, never before the opening entry. That day is live, as at
 *   any cutover: what was taken before the count is entered before activation
 *   (and credits nothing, the treasury not being live yet), so an entry for it
 *   made afterwards is new cash. At midday it was refused or credited to no
 *   wallet whenever activation came later in the day (14:00 or 15:00 in
 *   Beirut), and printed ahead of the opening balance it would show the safe
 *   overdrawn. The statement breaks the tie by `createdAt`, so the opening
 *   entry still comes first.
 */
export function documentOccurredAt(input: {
  day: string;
  today: string;
  now: Date;
  goLiveAt: Date | null;
}): Date {
  if (input.day === input.today) return input.now;
  const midday = new Date(`${input.day}T12:00:00.000Z`);
  const { goLiveAt } = input;
  return goLiveAt && midday < goLiveAt && municipalToday(goLiveAt) === input.day ? goLiveAt : midday;
}

/** The wallet the money of this method lands in, in this currency. */
function targetFor(
  method: PaymentMethod,
  currency: string,
  collectedById: string | null,
): { target: WalletTarget; collectorUnknown: boolean } {
  if (method === 'WHISH_MONEY') {
    return { target: { kind: 'PRIMARY', type: 'WHISH_ACCOUNT', currency }, collectorUnknown: false };
  }
  if (method === 'COLLECTOR') {
    // A collector's cash is with him until he hands it in — not yet in the safe.
    if (collectedById) {
      return { target: { kind: 'CUSTODY', ownerId: collectedById, currency }, collectorUnknown: false };
    }
    // No collector named: the safe is the only honest place left, and the
    // caller notes it on the entry so the accountant can see why.
    return { target: { kind: 'PRIMARY', type: 'CASH_SAFE', currency }, collectorUnknown: true };
  }
  return { target: { kind: 'PRIMARY', type: 'CASH_SAFE', currency }, collectorUnknown: false };
}

function sameTarget(a: WalletTarget, b: WalletTarget): boolean {
  if (a.kind !== b.kind || a.currency !== b.currency) return false;
  if (a.kind === 'PRIMARY' && b.kind === 'PRIMARY') return a.type === b.type;
  if (a.kind === 'CUSTODY' && b.kind === 'CUSTODY') return a.ownerId === b.ownerId;
  return false;
}

/**
 * The wallet movements of a payment received.
 *
 * - No tender: the credit goes in, in the invoice's currency.
 * - A tender: the invoice-currency notes go in, the foreign notes go into the
 *   foreign currency's wallet, and the change comes out of the invoice
 *   currency's wallet. The change and the invoice-currency notes are one wallet
 *   and are netted into one leg, so a $20 note against a 1,500,000 ل.ل bill
 *   with 500,000 ل.ل change is a single −500,000 ل.ل leg, not two.
 *
 * Legs that net to zero are dropped (an entry of zero is not an entry).
 */
export function planPaymentLegs(movement: PaymentMovement): {
  legs: WalletLeg[];
  collectorUnknown: boolean;
} {
  const { method, invoiceCurrency, tendered, collectedById } = movement;
  const home = targetFor(method, invoiceCurrency, collectedById);
  const legs: WalletLeg[] = [];

  const add = (target: WalletTarget, amount: number) => {
    if (amount === 0) return;
    const existing = legs.find((leg) => sameTarget(leg.target, target));
    if (existing) existing.amount = roundMoney(existing.amount + amount, target.currency);
    else legs.push({ target, amount: roundMoney(amount, target.currency) });
  };

  if (!tendered) {
    add(home.target, movement.amount);
  } else {
    add(home.target, tendered.local);
    if (tendered.foreign && tendered.foreignCurrency) {
      add(targetFor(method, tendered.foreignCurrency, collectedById).target, tendered.foreign);
    }
    add(home.target, -movement.changeGiven);
  }

  return { legs: legs.filter((leg) => leg.amount !== 0), collectorUnknown: home.collectorUnknown };
}

/**
 * The refund of a payment taken before go-live, reversed after it.
 *
 * Its cash was counted into an opening balance, so it left no entries to
 * reverse — but handing the money back takes cash out of the drawer today, and
 * the drawer count must show it. The detail of the original notes is not
 * replayed: the refund is the credit, in the invoice's currency, out of the
 * wallet of the original method (a collector's cash had been handed in by the
 * time of the count, so it is the safe).
 */
export function planPreGoLiveRefund(movement: {
  method: PaymentMethod;
  invoiceCurrency: string;
  amount: number;
}): WalletLeg[] {
  const { target } = targetFor(movement.method, movement.invoiceCurrency, null);
  const amount = roundMoney(movement.amount, movement.invoiceCurrency);
  return amount === 0 ? [] : [{ target, amount: -amount }];
}
