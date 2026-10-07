import {
  effectiveOwnerBilling,
  isCoOwned,
  ownerSharesPreview,
  type OwnerBillingMode,
  type OwnerBillingRule,
  type SetOwnerBillingInput,
} from '@mechanization/shared-schemas';

/**
 * «توزيع الرسم على المالكين» — what saving an officer's choice for a flat would
 * write, or why it cannot be saved. Pure: the service loads the facts under a
 * lock and writes what this returns.
 */

/** The flat as the plan needs it. */
export interface OwnerBillingFacts {
  unitCode: string;
  structural: boolean;
  mode: OwnerBillingMode | null;
  responsibleOwnerId: string | null;
  /** The flat's current OWNER spells. */
  spells: ReadonlyArray<{ id: string; citizenId: string; shares: number | null }>;
}

export type OwnerBillingRefusal =
  | { code: 'OWNER_BILLING_STRUCTURAL_UNIT'; params: { unitCode: string } }
  | { code: 'OWNER_BILLING_NOT_CO_OWNED'; params: { unitCode: string; owners: number } }
  | { code: 'OWNER_BILLING_SHARES_NOT_OWNER'; params: { unitCode: string } }
  | { code: 'OWNER_BILLING_RESPONSIBLE_NOT_OWNER'; params: { unitCode: string } }
  | { code: 'OWNER_BILLING_SHARES_MISSING'; params: { unitCode: string; missing: number } };

export interface OwnerBillingWrite {
  mode: OwnerBillingMode | null;
  responsibleOwnerId: string | null;
  /** أسهم to write onto spells — only the ones that change. */
  shareWrites: Array<{ spellId: string; citizenId: string; shares: number }>;
  /** The flat's rule once written — what billing will read. */
  rule: OwnerBillingRule;
  /** Whether anything changes at all; an identical save writes nothing. */
  changed: boolean;
}

export function planOwnerBilling(
  facts: OwnerBillingFacts,
  input: SetOwnerBillingInput,
): { ok: true; write: OwnerBillingWrite } | { ok: false; refusal: OwnerBillingRefusal } {
  const { unitCode } = facts;

  if (facts.structural) {
    return { ok: false, refusal: { code: 'OWNER_BILLING_STRUCTURAL_UNIT', params: { unitCode } } };
  }

  const ownerIds = new Set(facts.spells.map((spell) => spell.citizenId));

  /*
    A choice is only meaningful between two or more owners. Withdrawing one
    (`mode` null) is always allowed — a flat that lost a co-owner must be able
    to drop the choice that no longer applies.
  */
  if (input.mode !== null && ownerIds.size < 2) {
    return {
      ok: false,
      refusal: { code: 'OWNER_BILLING_NOT_CO_OWNED', params: { unitCode, owners: ownerIds.size } },
    };
  }

  // أسهم can only be recorded for someone who owns the flat now.
  if ((input.shares ?? []).some((entry) => !ownerIds.has(entry.citizenId))) {
    return { ok: false, refusal: { code: 'OWNER_BILLING_SHARES_NOT_OWNER', params: { unitCode } } };
  }

  const responsibleOwnerId = input.mode === 'RESPONSIBLE_OWNER' ? (input.responsibleOwnerId ?? null) : null;
  if (input.mode === 'RESPONSIBLE_OWNER' && (!responsibleOwnerId || !ownerIds.has(responsibleOwnerId))) {
    return { ok: false, refusal: { code: 'OWNER_BILLING_RESPONSIBLE_NOT_OWNER', params: { unitCode } } };
  }

  const sharesFor = new Map((input.shares ?? []).map((entry) => [entry.citizenId, entry.shares]));
  const shareWrites: OwnerBillingWrite['shareWrites'] = [];
  for (const spell of facts.spells) {
    const next = sharesFor.get(spell.citizenId);
    if (next !== undefined && next !== spell.shares) {
      shareWrites.push({ spellId: spell.id, citizenId: spell.citizenId, shares: next });
    }
  }

  const rule: OwnerBillingRule = {
    mode: input.mode,
    responsibleOwnerId,
    owners: facts.spells.map((spell) => ({
      citizenId: spell.citizenId,
      shares: sharesFor.get(spell.citizenId) ?? spell.shares,
    })),
  };

  /*
    «حسب الأسهم» is saved only when every owner's أسهم are on record — the
    figure billing would otherwise refuse to compute (`ownerShareOf`). Refused
    here, where the officer can type them, rather than on the first bill.
  */
  if (input.mode === 'BY_SHARES' && isCoOwned(rule)) {
    const preview = ownerSharesPreview(rule);
    if (preview.owners.some((owner) => owner.outcome.kind === 'UNDECIDABLE')) {
      const missing = preview.owners.filter((owner) => !(owner.shares && owner.shares > 0)).length;
      return {
        ok: false,
        refusal: { code: 'OWNER_BILLING_SHARES_MISSING', params: { unitCode, missing } },
      };
    }
  }

  const changed =
    shareWrites.length > 0 || facts.mode !== input.mode || facts.responsibleOwnerId !== responsibleOwnerId;

  return { ok: true, write: { mode: input.mode, responsibleOwnerId, shareWrites, rule, changed } };
}

/** What a flat's billing looks like to the drawer: the choice, what is in force, and each owner's part. */
export function describeOwnerBilling(rule: OwnerBillingRule) {
  const preview = ownerSharesPreview(rule);
  return {
    mode: rule.mode,
    responsibleOwnerId: rule.responsibleOwnerId,
    effective: effectiveOwnerBilling(rule),
    owners: preview.owners,
  };
}
