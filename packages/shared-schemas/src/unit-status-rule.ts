/**
 * What a flat's «حالة الوحدة» is, decided in one place.
 *
 * ## Why one rule
 *
 * The same fact — who is in this flat, and so who pays its occupancy fee — is
 * written in three places: the unit on the building matrix, the owner's card
 * (a line on a مبنى card, or the card itself for a منزل), and the census
 * spells in `unit_occupancies`. Until 2026-09-30 seven different actions wrote
 * the unit's copy, under two opposite rules (a registered tenant filled it only
 * when empty; an owner's card overwrote it every save), and nothing compared the
 * copies. The production audit that day found a seasonal home billed to both its
 * owner and the tenant registered in it, and 23 flats marked «مؤجرة» with no
 * tenant anywhere — owner exempt, nobody charged.
 *
 * Registries that do not have this problem keep one authoritative source per
 * fact and derive the rest (the Dutch base-register rule; Dubai's Ejari, where
 * the tenancy *is* the unit's occupancy record), and put what they cannot settle
 * to a person instead of letting the last writer win. This is that rule.
 *
 * ## The rule
 *
 *  1. A standing «تأكيد الشغور» makes the flat «شاغرة». It is a finding with a
 *     basis, a date and somebody's name on it.
 *  2. Otherwise a registered مستأجر makes it «مؤجرة», and failing that a
 *     registered شاغل بتسامح makes it «مشغولة بتسامح». The person living there
 *     beats any statement that nobody does, or that the owner does — a running
 *     lease defeats a vacancy declaration (هيئة التشريع والاستشارات 725/2003),
 *     and one flat has one occupant-fee bearer.
 *  3. Otherwise the flat keeps what a person last said about it — the officer's
 *     finding or the owner's answer. Nothing here invents one.
 *
 * ## What it cannot settle
 *
 * Returned as conflicts, for a person to look at — never resolved by guessing:
 *
 *  - **LET_WITHOUT_OCCUPANT** — «مؤجرة» or «مشغولة بتسامح» with nobody of that
 *    kind registered. The owner is exempt because someone else pays, and there
 *    is no someone else. Either the tenant is registered, or the flat is not
 *    let after all.
 *  - **OWNER_STATEMENT_DIFFERS** — an owner's card says something about the flat
 *    that changes who pays, against what the unit now says. Compared by who
 *    pays, not by word: «مؤجرة» against «مشغولة بتسامح» both mean somebody else
 *    is billed, and flagging that would bury the disagreements that cost money.
 *  - **VACANCY_WITH_OCCUPANT** — a standing vacancy with someone registered
 *    inside. Every door that records an occupant closes the vacancy first, so
 *    this should not happen; if it does, it is shown rather than rewritten.
 *
 * A flat with a conflict is under review, and its occupancy fee is held until
 * the conflict is gone (the user's decision, 2026-09-30).
 *
 * Pure, so the census sync, the matrix, billing and the quality scan all ask
 * the same function and cannot drift.
 */

/** «مؤجرة» and «مشغولة بتسامح» — somebody other than the owner lives there. */
const LET = new Set(['RENTED', 'FREE_OCCUPIED']);
/** «شاغرة» and «قيد الإنجاز» — nobody lives there. */
const EMPTY = new Set(['VACANT', 'UNDER_CONSTRUCTION']);

export type UnitStatusConflict =
  | { kind: 'LET_WITHOUT_OCCUPANT'; status: string }
  | { kind: 'OWNER_STATEMENT_DIFFERS'; stated: string; status: string }
  | { kind: 'VACANCY_WITH_OCCUPANT' };

export interface UnitStatusFacts {
  /** `Unit.unitStatus` as stored now. */
  current: string | null;
  /** Whether a «تأكيد الشغور» is standing on the unit. */
  standingVacancy: boolean;
  /** The role of every current spell on the unit — OWNER, TENANT, FREE_OCCUPANT. */
  liveRoles: readonly string[];
  /**
   * حالة الوحدة as each current owner's card states it — a مبنى line naming the
   * flat, or a منزل card on a one-unit structure. Null where the card states
   * none, which is not a statement and never a conflict.
   */
  ownerStatements: readonly (string | null)[];
}

export interface SettledUnitStatus {
  status: string | null;
  conflicts: UnitStatusConflict[];
}

/**
 * Who bears the occupancy fee under a status: the owner, somebody else, or
 * nobody. Null for null — "never asked" is not a statement.
 */
export function feeBearerClass(status: string | null | undefined): 'OWNER' | 'OTHERS' | 'NOBODY' | null {
  if (status == null) return null;
  if (LET.has(status)) return 'OTHERS';
  if (EMPTY.has(status)) return 'NOBODY';
  return 'OWNER';
}

/** The status a live occupant implies, or null when only owners are recorded. */
export function occupantImpliedStatus(liveRoles: readonly string[]): string | null {
  if (liveRoles.includes('TENANT')) return 'RENTED';
  if (liveRoles.includes('FREE_OCCUPANT')) return 'FREE_OCCUPIED';
  return null;
}

export function settleUnitStatus(facts: UnitStatusFacts): SettledUnitStatus {
  const implied = occupantImpliedStatus(facts.liveRoles);
  const conflicts: UnitStatusConflict[] = [];

  let status: string | null;
  if (facts.standingVacancy) {
    status = 'VACANT';
    if (implied) conflicts.push({ kind: 'VACANCY_WITH_OCCUPANT' });
  } else if (implied) {
    status = implied;
  } else {
    status = facts.current;
  }

  /*
    «مؤجرة» / «مشغولة بتسامح» with nobody of that kind registered — read from
    the unit, or, while the unit has no answer, from an owner's card: billing
    reads the card then, so the owner is exempt on the card's word alone and
    nobody is billed for the flat.
  */
  if (!facts.standingVacancy && !implied) {
    const letStatus =
      status !== null
        ? LET.has(status)
          ? status
          : null
        : (facts.ownerStatements.find((stated): stated is string => stated != null && LET.has(stated)) ?? null);
    if (letStatus) conflicts.push({ kind: 'LET_WITHOUT_OCCUPANT', status: letStatus });
  }

  /*
    An owner's statement against a unit that has an answer. Against a null unit
    it is the only statement there is — billing reads it, and the census sync
    carries it onto the unit — so it contradicts nothing.
  */
  const settledClass = feeBearerClass(status);
  if (settledClass !== null) {
    const seen = new Set<string>();
    for (const stated of facts.ownerStatements) {
      if (stated == null || seen.has(stated)) continue;
      seen.add(stated);
      if (feeBearerClass(stated) !== settledClass) {
        conflicts.push({ kind: 'OWNER_STATEMENT_DIFFERS', stated, status: status! });
      }
    }
  }

  return { status, conflicts };
}

/** Arabic text for a conflict, for the case note and the drawer. */
export function describeUnitStatusConflict(
  conflict: UnitStatusConflict,
  label: (status: string) => string = (status) => status,
): string {
  switch (conflict.kind) {
    case 'LET_WITHOUT_OCCUPANT':
      return `الوحدة مسجَّلة «${label(conflict.status)}» ولا يوجد ${
        conflict.status === 'RENTED' ? 'مستأجر' : 'شاغل'
      } مسجَّل فيها — سجِّله على الوحدة، أو صحِّح حالتها`;
    case 'OWNER_STATEMENT_DIFFERS':
      return `بطاقة المالك تقول «${label(conflict.stated)}» والوحدة «${label(
        conflict.status,
      )}» — تحقّق وصحِّح أحدهما`;
    case 'VACANCY_WITH_OCCUPANT':
      return 'الوحدة مؤكَّد شغورها وفيها مستأجر أو شاغل مسجَّل — أنهِ أحدهما';
  }
}
