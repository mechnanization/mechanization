import { BULK_SETTLE_MAX_BILLS } from '@mechanization/shared-schemas';
import type { AdminPaymentItem, CitizenProfilePayment } from './api-client';

/**
 * «تسديد الفواتير المحددة» — what the screens decide before the dialog opens:
 * which bills may be ticked, whose they are, what the ticked set owes, and the
 * retry key the set is held under. Pure, and tested beside it
 * (`bulk-settle.test.ts`). The server decides all of it again under the bills'
 * locks (`planBulkSettlement` in shared-schemas); this only keeps the screen
 * from offering what it would refuse.
 */

/**
 * One ticked bill, kept whole rather than as an id, so the totals stay right
 * when the clerk turns a page of /fees and the row is no longer on screen.
 */
export interface SelectedBill {
  id: string;
  citizenId: string;
  citizenName: string;
  /** «INV-…», or null for a bill raised before migration 0079. */
  invoiceNumber: string | null;
  title: string;
  currency: string;
  /** What is still owed on it, as the list read it. */
  remaining: number;
  dueDate: string;
  /**
   * When the bill was raised: the tie-break of «oldest first». The citizen
   * file's rows do not carry it, and pass the due date instead, which leaves
   * the tie to the id (`bulkSettlementOrder`).
   */
  createdAt: string;
}

/**
 * A row of the fees register (`GET fees/payments`) as a ticked bill. The two
 * fields an API older than the bulk settlement does not send fall back as the
 * citizen file's rows do.
 */
export function fromAdminPayment(row: AdminPaymentItem): SelectedBill {
  return {
    id: row.id,
    citizenId: row.citizenId,
    citizenName: row.citizenName,
    invoiceNumber: row.invoiceNumber ?? null,
    title: row.title,
    currency: row.currency,
    remaining: row.remaining,
    dueDate: row.dueDate,
    createdAt: row.createdAt ?? row.dueDate,
  };
}

/** A bill on a citizen's file as a ticked bill. The file's rows carry no `createdAt` (see `SelectedBill`). */
export function fromCitizenPayment(citizen: { id: string; fullName: string }, row: CitizenProfilePayment): SelectedBill {
  return {
    id: row.id,
    citizenId: citizen.id,
    citizenName: citizen.fullName,
    invoiceNumber: row.invoiceNumber,
    title: row.title,
    currency: row.currency,
    remaining: row.remaining,
    dueDate: row.dueDate,
    createdAt: row.dueDate,
  };
}

/**
 * Whether a bill may be ticked: something is still owed on it, and it is
 * neither paid nor a Whish claim waiting for review — a claim is settled by
 * confirming it, not by taking the money a second time.
 */
export function isBulkSettleable(row: { paymentStatus: string; remaining: number }): boolean {
  return row.remaining > 0 && (row.paymentStatus === 'UNPAID' || row.paymentStatus === 'OVERDUE');
}

/**
 * Why a box is off:
 * - `otherCitizen`: the set already holds another citizen's bills (one press settles one person's);
 * - `limit`: the set is full (`BULK_SETTLE_MAX_BILLS`);
 * - `mixedCitizens`: «تحديد الكل» over a page that lists several citizens' bills.
 */
export type BulkBlockReason = 'otherCitizen' | 'limit' | 'mixedCitizens';

/** Whose bills the set holds, or null while it is empty. */
export function selectedCitizen(bills: readonly SelectedBill[]): { id: string; name: string } | null {
  const first = bills[0];
  return first ? { id: first.citizenId, name: first.citizenName } : null;
}

/** Why this row's box may not be ticked, or null when it may (or is ticked already, and may be unticked). */
export function rowBlock(
  bills: readonly SelectedBill[],
  candidate: Pick<SelectedBill, 'id' | 'citizenId'>,
): BulkBlockReason | null {
  if (bills.some((bill) => bill.id === candidate.id)) return null;
  const owner = bills[0]?.citizenId;
  if (owner && owner !== candidate.citizenId) return 'otherCitizen';
  if (bills.length >= BULK_SETTLE_MAX_BILLS) return 'limit';
  return null;
}

/** Ticks or unticks one bill. A tick `rowBlock` refuses leaves the set as it was. */
export function toggleBill(bills: readonly SelectedBill[], bill: SelectedBill): readonly SelectedBill[] {
  if (bills.some((entry) => entry.id === bill.id)) return bills.filter((entry) => entry.id !== bill.id);
  if (rowBlock(bills, bill)) return bills;
  return [...bills, bill];
}

/** Where «تحديد الكل» stands over one page's settleable rows. */
export interface PageSelection {
  /** How many settleable rows the page shows. */
  eligible: number;
  /** Every one of them is ticked; pressing unticks them. */
  allSelected: boolean;
  /** Why it may not be pressed, or null when it may. */
  blocked: BulkBlockReason | null;
}

/**
 * «تحديد الكل» over the page. `rows` are the page's settleable rows only. It
 * ticks them when they are one citizen's — the one already selected, if any —
 * and the set has room for all of them; unticking is always allowed.
 */
export function pageSelection(bills: readonly SelectedBill[], rows: readonly SelectedBill[]): PageSelection {
  if (rows.length === 0) return { eligible: 0, allSelected: false, blocked: null };
  const ticked = new Set(bills.map((bill) => bill.id));
  const allSelected = rows.every((row) => ticked.has(row.id));
  if (allSelected) return { eligible: rows.length, allSelected, blocked: null };
  const citizens = new Set(rows.map((row) => row.citizenId));
  let blocked: BulkBlockReason | null = null;
  if (citizens.size > 1) blocked = 'mixedCitizens';
  else if (bills.length > 0 && !citizens.has(bills[0]!.citizenId)) blocked = 'otherCitizen';
  else if (bills.length + rows.filter((row) => !ticked.has(row.id)).length > BULK_SETTLE_MAX_BILLS) blocked = 'limit';
  return { eligible: rows.length, allSelected, blocked };
}

/** Presses «تحديد الكل»: unticks the page when it is all ticked, else ticks what `pageSelection` allows. */
export function togglePage(bills: readonly SelectedBill[], rows: readonly SelectedBill[]): readonly SelectedBill[] {
  const state = pageSelection(bills, rows);
  if (state.eligible === 0) return bills;
  if (state.allSelected) {
    const onPage = new Set(rows.map((row) => row.id));
    return bills.filter((bill) => !onPage.has(bill.id));
  }
  if (state.blocked) return bills;
  const ticked = new Set(bills.map((bill) => bill.id));
  return [...bills, ...rows.filter((row) => !ticked.has(row.id))];
}

/**
 * The set against a fresh read of the rows. A ticked bill the read shows as
 * still settleable takes the read's figures; one it shows paid, or sent for
 * review, since it was ticked is dropped, because its box is gone and nothing
 * on screen could untick it. A ticked bill the read does not show (another
 * page of /fees) is kept as it was: the server judges it again under its lock.
 *
 * Returns the same array when nothing changed, so a page can run it on every
 * read without re-rendering.
 */
export function reconcileSelection(
  bills: readonly SelectedBill[],
  fresh: ReadonlyArray<{ bill: SelectedBill; settleable: boolean }>,
): readonly SelectedBill[] {
  if (bills.length === 0) return bills;
  const byId = new Map(fresh.map((entry) => [entry.bill.id, entry]));
  let changed = false;
  const next: SelectedBill[] = [];
  for (const bill of bills) {
    const seen = byId.get(bill.id);
    if (!seen) {
      next.push(bill);
      continue;
    }
    if (!seen.settleable) {
      changed = true;
      continue;
    }
    if (
      seen.bill.remaining !== bill.remaining ||
      seen.bill.currency !== bill.currency ||
      seen.bill.invoiceNumber !== bill.invoiceNumber ||
      seen.bill.title !== bill.title ||
      seen.bill.dueDate !== bill.dueDate
    ) {
      changed = true;
      next.push(seen.bill);
      continue;
    }
    next.push(bill);
  }
  return changed ? next : bills;
}

/** Whole ليرة for ليرة, cents for any other currency — the ledger's own precision. */
function roundIn(value: number, currency: string): number {
  return currency === 'LBP' ? Math.round(value) : Math.round(value * 100) / 100;
}

/**
 * What the set owes, per currency: the municipality's own currency first, then
 * the others by code — «1,800,000 ل.ل + 40 $».
 */
export function dueByCurrency(
  bills: readonly Pick<SelectedBill, 'currency' | 'remaining'>[],
  baseCurrency = 'LBP',
): Array<{ currency: string; amount: number }> {
  const totals = new Map<string, number>();
  for (const bill of bills) {
    totals.set(bill.currency, roundIn((totals.get(bill.currency) ?? 0) + bill.remaining, bill.currency));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a === baseCurrency ? -1 : b === baseCurrency ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount]) => ({ currency, amount }));
}

/**
 * The retry key's scope for one set of bills (`lib/request-id.ts`): the same
 * set, in any order, is the same act; another set is another act with its own
 * key. Unticking a bill after a refusal therefore starts a new act, which the
 * server's all-or-nothing rule makes safe — a bill an earlier lost attempt paid
 * is refused as paid (`BULK_SETTLE_SOME_ALREADY_PAID`), never paid twice.
 */
export function bulkKeyScope(ids: readonly string[]): `bulk-settle:${string}` {
  return `bulk-settle:${[...ids].sort().join(',')}`;
}

/** One parcel or unit a bill was assessed on, as the receipt words it. */
export interface PropertyLine {
  /**
   * Which message words it, by what is known: the parcel number, the unit's
   * type, the unit's code (`bulkSettle.receipt.property.*`).
   */
  key: 'parcelTypeCode' | 'parcelType' | 'parcelCode' | 'parcel' | 'typeCode' | 'type' | 'code';
  parcel: string | null;
  unitType: string | null;
  unitCode: string | null;
}

/**
 * A bill's parcels and units (`SettlementReceiptItem.properties`) as lines to
 * word: blank parts dropped, an entry with nothing in it dropped, a repeat
 * dropped. Empty for a flat or one-off charge, which the receipt prints as «—».
 */
export function propertyLines(
  properties: ReadonlyArray<{ propertyNumber: string | null; unitType: string | null; unitCode: string | null }>,
): PropertyLine[] {
  const seen = new Set<string>();
  const lines: PropertyLine[] = [];
  for (const entry of properties) {
    const parcel = entry.propertyNumber?.trim() || null;
    const unitType = entry.unitType?.trim() || null;
    const unitCode = entry.unitCode?.trim() || null;
    const fingerprint = `${parcel ?? ''}|${unitType ?? ''}|${unitCode ?? ''}`;
    if (fingerprint === '||' || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const key: PropertyLine['key'] = parcel
      ? unitType
        ? unitCode
          ? 'parcelTypeCode'
          : 'parcelType'
        : unitCode
          ? 'parcelCode'
          : 'parcel'
      : unitType
        ? unitCode
          ? 'typeCode'
          : 'type'
        : 'code';
    lines.push({ key, parcel, unitType, unitCode });
  }
  return lines;
}
