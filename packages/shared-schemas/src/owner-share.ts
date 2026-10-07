/**
 * «توزيع الرسم على المالكين» — what part of a co-owned flat each owner is billed
 * for (migration 0075; the user's decision, 2026-10-07).
 *
 * One rule, read by the three places that must agree: the fee assessment
 * (`assessCitizen`, through `holdingsOf`), the unit drawer that previews each
 * owner's part before an officer saves a choice, and the server that refuses a
 * choice billing could not carry out. Pure, no I/O, so both apps run it.
 *
 * The owners are the flat's **current OWNER spells** (`unit_occupancies`,
 * `toDate` NULL), one per person. That is the census's statement of who holds
 * the deed today, and it is what the denominator has to be: an owner whose own
 * file does not yet claim the flat still owns their part of it, and billing
 * the others for it would charge brother A for brother B's quarter. Their part
 * goes unbilled until their file is completed, which the matrix already flags
 * («لا يوجد في ملفه»).
 */
import type { OwnerBillingMode } from './enums';

/** What billing needs to know about one flat's owners. */
export interface OwnerBillingRule {
  /** The officer's choice, or null when nobody chose — billed as EQUAL. */
  mode: OwnerBillingMode | null;
  /** Who pays the whole under RESPONSIBLE_OWNER; null otherwise. */
  responsibleOwnerId: string | null;
  /** The flat's current OWNER spells, with their أسهم where recorded. */
  owners: ReadonlyArray<{ citizenId: string; shares: number | null }>;
}

/** One owner's part of a flat, as a fraction so nothing is lost to floats until the amount is rounded. */
export interface OwnerShare {
  /** The method that produced it — the effective one, after any fallback. */
  mode: OwnerBillingMode;
  numerator: number;
  denominator: number;
}

/**
 * Why the method applied is not the one the officer chose.
 *
 *  - `RESPONSIBLE_NOT_OWNER` — the responsible owner no longer holds a current
 *    OWNER spell on the flat (sold, ended, merged away), so naming them would
 *    bill nobody. The flat is split equally until someone chooses again.
 */
export type OwnerBillingFallback = 'RESPONSIBLE_NOT_OWNER';

/** The method in force on a flat, and the owners it is applied to. */
export interface EffectiveOwnerBilling {
  mode: OwnerBillingMode;
  /** True when nobody chose and EQUAL is the default rather than a decision. */
  defaulted: boolean;
  fallback: OwnerBillingFallback | null;
  /** One entry per person, in the order first seen. */
  owners: ReadonlyArray<{ citizenId: string; shares: number | null }>;
}

/**
 * One owner's outcome on one flat.
 *
 *  - `WHOLE` — the flat has one owner, or this person is not among its owners
 *    of record (a card the census does not back — billed as it always was, and
 *    flagged on the matrix as a record that disagrees).
 *  - `SHARE` — the part this owner is billed for; `numerator` 0 means another
 *    owner pays for this flat.
 *  - `UNDECIDABLE` — BY_SHARES with an owner whose أسهم are not recorded. A
 *    figure here would be a guess, so billing refuses it the way it refuses a
 *    flat with no area, and the officer records the أسهم.
 */
export type OwnerShareOutcome =
  | { kind: 'WHOLE' }
  | { kind: 'SHARE'; share: OwnerShare }
  | { kind: 'UNDECIDABLE'; reason: 'SHARES_MISSING' };

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function fraction(mode: OwnerBillingMode, numerator: number, denominator: number): OwnerShare {
  if (numerator === 0) return { mode, numerator: 0, denominator: 1 };
  const divisor = gcd(numerator, denominator);
  return { mode, numerator: numerator / divisor, denominator: denominator / divisor };
}

/** A recorded أسهم figure billing can divide by — a positive whole number. */
function usableShares(shares: number | null | undefined): shares is number {
  return typeof shares === 'number' && Number.isInteger(shares) && shares > 0;
}

/** The flat's owners, one per person — a citizen with two spells on one flat is still one owner. */
function distinctOwners(rule: OwnerBillingRule): Array<{ citizenId: string; shares: number | null }> {
  const byCitizen = new Map<string, { citizenId: string; shares: number | null }>();
  for (const owner of rule.owners) {
    const seen = byCitizen.get(owner.citizenId);
    if (!seen) byCitizen.set(owner.citizenId, { citizenId: owner.citizenId, shares: owner.shares ?? null });
    else if (!usableShares(seen.shares) && usableShares(owner.shares)) seen.shares = owner.shares;
  }
  return [...byCitizen.values()];
}

/** Whether the flat has more than one owner — the only case any of this applies to. */
export function isCoOwned(rule: Pick<OwnerBillingRule, 'owners'>): boolean {
  return new Set(rule.owners.map((owner) => owner.citizenId)).size > 1;
}

/** The method in force, after the default and the fallback. */
export function effectiveOwnerBilling(rule: OwnerBillingRule): EffectiveOwnerBilling {
  const owners = distinctOwners(rule);
  if (rule.mode === 'RESPONSIBLE_OWNER') {
    const current = owners.some((owner) => owner.citizenId === rule.responsibleOwnerId);
    if (!current) return { mode: 'EQUAL', defaulted: false, fallback: 'RESPONSIBLE_NOT_OWNER', owners };
  }
  return { mode: rule.mode ?? 'EQUAL', defaulted: rule.mode === null, fallback: null, owners };
}

/**
 * The part of this flat `citizenId` is billed for, as an owner.
 *
 * Says nothing about whether the fee falls on the owners at all — that is
 * `bearsFee`'s question, asked first. This only divides what the owners owe.
 */
export function ownerShareOf(rule: OwnerBillingRule, citizenId: string): OwnerShareOutcome {
  const effective = effectiveOwnerBilling(rule);
  const { owners } = effective;
  if (owners.length < 2) return { kind: 'WHOLE' };
  if (!owners.some((owner) => owner.citizenId === citizenId)) return { kind: 'WHOLE' };

  switch (effective.mode) {
    case 'RESPONSIBLE_OWNER':
      return {
        kind: 'SHARE',
        share: fraction('RESPONSIBLE_OWNER', citizenId === rule.responsibleOwnerId ? 1 : 0, 1),
      };
    case 'BY_SHARES': {
      if (!owners.every((owner) => usableShares(owner.shares))) {
        return { kind: 'UNDECIDABLE', reason: 'SHARES_MISSING' };
      }
      const total = owners.reduce((sum, owner) => sum + (owner.shares as number), 0);
      const mine = owners.find((owner) => owner.citizenId === citizenId)!.shares as number;
      return { kind: 'SHARE', share: fraction('BY_SHARES', mine, total) };
    }
    case 'EQUAL':
    default:
      return { kind: 'SHARE', share: fraction('EQUAL', 1, owners.length) };
  }
}

/** The weight a share multiplies a unit by — 1 for a whole flat. */
export function shareWeight(share: OwnerShare | null | undefined): number {
  return share ? share.numerator / share.denominator : 1;
}

/**
 * Every owner's part at once, for the unit drawer's preview: what each owner
 * would be billed for under `rule`, and whether billing can carry it out.
 */
export function ownerSharesPreview(rule: OwnerBillingRule): {
  effective: EffectiveOwnerBilling;
  owners: Array<{ citizenId: string; shares: number | null; outcome: OwnerShareOutcome }>;
} {
  const effective = effectiveOwnerBilling(rule);
  return {
    effective,
    owners: effective.owners.map((owner) => ({
      citizenId: owner.citizenId,
      shares: owner.shares,
      outcome: ownerShareOf(rule, owner.citizenId),
    })),
  };
}
