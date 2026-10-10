import type { FeeAssessment, FeeAssessmentLine } from '@mechanization/shared-schemas';
import type { AuditRow } from '../../../domain/interfaces/audit-repository.interface';

/**
 * «فواتير تأثّرت بتصحيحات» — the rules, apart from the reads.
 *
 * A bill is frozen when it is raised (`CitizenPayment.assessment`) and stays
 * true to that moment: a citizen who sells a shop the week after being billed
 * still owes that month. So a bill whose figure no longer matches the register
 * is not wrong by itself. It is wrong when the register *was* wrong when the
 * bill was raised, and somebody has since corrected it.
 *
 * The trail says which. Every change recorded on the citizen's file, or on a
 * unit they hold, since the bill was raised is one of three things:
 *
 *  - **CORRECTION**: said to be one. A card or a spell ended as «سُجّل خطأً»,
 *    a link undone, an edit saved with a reason (R1).
 *  - **DATED_CHANGE**: a real change with the day it took effect. A sale, a
 *    tenant moving out.
 *  - **EDIT**: anything else that moves holdings. The edit form records what
 *    is true, not what changed on a day, so an edit is read as a correction
 *    unless it says otherwise.
 *
 * The bill is listed when its figure differs and at least one change is not a
 * real change that took effect after the bill was raised. A move-out after the
 * bill leaves the bill right; a move-out dated before it means the register was
 * late and the bill was not.
 *
 * Bills are never changed here. The accountant decides.
 */

export type ChangeKind = 'CORRECTION' | 'DATED_CHANGE' | 'EDIT';

export interface TracedChange {
  row: AuditRow;
  kind: ChangeKind;
  /** When a real change took effect. Null for everything else. */
  effectiveOn: Date | null;
}

/** What a bill would be if it were raised now. */
export type BillFigure =
  | { kind: 'ASSESSED'; amount: number; assessment: FeeAssessment | null }
  | { kind: 'UNASSESSABLE'; reason: string }
  /** A flat charge aimed at a category the citizen no longer holds any of. */
  | { kind: 'NOT_TARGETED' };

/** Endings that happened in the world, as opposed to ones entered by mistake. */
const REAL_ENDINGS = new Set(['MOVED_OUT', 'OWNERSHIP_TRANSFERRED']);

/**
 * File actions that can move what a citizen is billed for.
 *
 * An allowlist: a new action on a citizen's file is not a billing change until
 * someone says it is. The landlord actions write rows onto the owner's card
 * (the link footprint), which is why they are here.
 */
export const FILE_ACTIONS = [
  'CITIZEN_UPDATED',
  'TENANCY_ENDED',
  'OWNERSHIP_ENDED',
  'LANDLORD_LINKED',
  'LANDLORD_LINK_UPDATED',
  'LANDLORD_UNLINKED',
  'LANDLORD_LINK_REVERTED',
  'LANDLORD_TENANCY_ENDED',
  'LANDLORD_LINK_RELEASED_BY_SALE',
  /*
    «دمج ملفين» and its undo. A merge moves bills and holdings between two
    files, and a bill both files carried stays on the one folded away — each is
    a bill raised on a register that was wrong, which is a correction by
    definition.
  */
  'CITIZEN_MERGED',
  'CITIZEN_MERGED_INTO',
  'CITIZEN_MERGE_UNDONE',
  // «حذف وحدة سُجِّلت بالخطأ»: the file's lines on it close RECORDED_IN_ERROR.
  'UNIT_CORRECTION_FILE_ENDED',
] as const;

/** Unit actions, recorded on the building, that can move its holders' bills. */
export const UNIT_ACTIONS = [
  'UNIT_UPDATED',
  'UNIT_DELETED',
  'OCCUPANCY_RECORDED',
  'OCCUPANCY_ENDED',
  'UNIT_VACANCY_CONFIRMED',
  'UNIT_VACANCY_ENDED',
  'UNIT_STATUS_AFTER_TENANCY',
  'UNIT_CORRECTION_DELETED',
  /*
    A damage reading can exempt a flat from every fee («غير صالحة للسكن», the
    user's decisions of 2026-10-05 and 2026-10-07) or end that. Today's figure
    already reflects it (`assessCitizen`), so the reading is listed beside it —
    as a real change on the day it was recorded, which never makes a bill one a
    correction affected on its own: the exemption runs forward, never back.
  */
  'DAMAGE_RECORDED',
  /*
    «توزيع الرسم على المالكين» (migration 0075): which part of a co-owned flat
    each owner is billed for. A choice the office makes going forward, like a
    damage reading — listed as a real change on the day it was made, so a bill
    raised before it stays as it was raised.
  */
  'UNIT_OWNER_BILLING_SET',
  /*
    «معفاة من الرسوم» (migration 0077), granted or lifted by the office.

    Granting is a correction of fact (the user's decision, 2026-10-08): the
    mosque was a mosque before anyone ticked the box, so a bill raised on it
    earlier was raised on a register that was wrong — listed whatever day it
    was raised, as a «سُجّل خطأً» is. Lifting runs forward from the day, like
    the billing method above: the unit owes from then, not before.
  */
  'UNIT_FEE_EXEMPTION_SET',
  'UNIT_FEE_EXEMPTION_LIFTED',
] as const;

/** The unit fields `assessCitizen` reads. A rename or a floor move bills nothing. */
const BILLED_UNIT_FIELDS = new Set(['unitType', 'unitArea', 'unitStatus']);

/**
 * A spell ending that the citizen's own file already records. The building's
 * row repeats it; the file's row is the one that carries the whole story.
 */
const RECORDED_ON_FILE = new Set(['TENANCY_ENDED', 'OWNERSHIP_ENDED', 'REGISTRATION']);

type Json = Record<string, unknown>;

const json = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const date = (value: unknown): Date | null => {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

function byReason(reason: string | null, on: Date | null): Omit<TracedChange, 'row'> {
  if (reason === 'RECORDED_IN_ERROR') return { kind: 'CORRECTION', effectiveOn: null };
  if (reason && REAL_ENDINGS.has(reason) && on) return { kind: 'DATED_CHANGE', effectiveOn: on };
  return { kind: 'EDIT', effectiveOn: null };
}

/**
 * An edit to the file. Null when it touched nothing billing reads — a phone
 * number, a name.
 */
function fileEdit(after: Json): Omit<TracedChange, 'row'> | null {
  /*
    A move into or out of the town («تغيير الإقامة») is a real change with its
    day, though it carries the reason every change of residence is asked for.
  */
  const movedOn = date(after.movedOn);
  if (movedOn) return { kind: 'DATED_CHANGE', effectiveOn: movedOn };
  // A reason is only asked for a correction (R1), so an edit that carries one is one.
  if (text(after.reason)) return { kind: 'CORRECTION', effectiveOn: null };

  const removals = Array.isArray(after.removals) ? after.removals.map(json) : [];
  if (removals.some((removal) => removal.reason === 'RECORDED_IN_ERROR')) {
    return { kind: 'CORRECTION', effectiveOn: null };
  }
  /*
    Since R8 an edit names what it changed: `changed` for the file's own fields,
    `cards` for the property cards — each only when non-empty. One with
    neither was written before that, or changed nothing, and cannot say which:
    read as an edit.
  */
  if (!Array.isArray(after.cards)) {
    return Array.isArray(after.changed) ? null : { kind: 'EDIT', effectiveOn: null };
  }
  const cards = after.cards.map(json);
  if (cards.length === 0) return null;

  /*
    A save that only removed cards, each with a real ending and its day, is that
    ending — the edit form's «بيع / انتقال» answer (Phase 1). The earliest day
    decides: if any of it took effect before the bill, the bill was wrong.
  */
  const days = removals.map((removal) => (REAL_ENDINGS.has(String(removal.reason)) ? date(removal.endedAt) : null));
  const onlyRemovals = cards.every((card) => card.kind === 'removed') && removals.length >= cards.length;
  if (onlyRemovals && days.length > 0 && days.every((day) => day !== null)) {
    const earliest = new Date(Math.min(...days.map((day) => day!.getTime())));
    return { kind: 'DATED_CHANGE', effectiveOn: earliest };
  }
  return { kind: 'EDIT', effectiveOn: null };
}

/**
 * The changes, among these rows, that can have moved this citizen's bills —
 * each read as a correction, a dated change or an edit.
 *
 * `rows` are the audit entries on the citizen's file (`User`) and on the
 * buildings they hold in (`Building`). A building row counts when it names the
 * citizen or one of the units they hold; the rest of the building is somebody
 * else's bill.
 */
export function traceChanges(
  rows: readonly AuditRow[],
  holder: { citizenId: string; unitCodes: ReadonlySet<string> },
): TracedChange[] {
  /*
    When a tenant's spell ended, by tenant. The owner's side of a tenancy ending
    (their flat's status, their link) does not carry the day; the tenant's spell
    does, and it is the same event.
  */
  const endings = new Map<string, { reason: string | null; on: Date | null }>();
  for (const row of rows) {
    if (row.entityType !== 'Building' || row.action !== 'OCCUPANCY_ENDED') continue;
    const before = json(row.before);
    const after = json(row.after);
    const citizenId = text(after.citizenId) ?? text(before.citizenId);
    if (citizenId) endings.set(citizenId, { reason: text(after.reason), on: date(after.toDate) });
  }
  const tenantEnding = (tenantId: unknown) => {
    const ending = typeof tenantId === 'string' ? endings.get(tenantId) : undefined;
    return byReason(ending?.reason ?? null, ending?.on ?? null);
  };

  const traced: TracedChange[] = [];
  for (const row of rows) {
    const before = json(row.before);
    const after = json(row.after);
    let change: Omit<TracedChange, 'row'> | null = null;

    if (row.entityType === 'User') {
      if (row.entityId !== holder.citizenId) continue;
      switch (row.action) {
        case 'CITIZEN_UPDATED':
          change = fileEdit(after);
          break;
        case 'TENANCY_ENDED':
        case 'OWNERSHIP_ENDED':
          change = byReason(text(after.reason), date(after.endedAt));
          break;
        case 'LANDLORD_UNLINKED':
        case 'CITIZEN_MERGED':
        case 'CITIZEN_MERGED_INTO':
        case 'CITIZEN_MERGE_UNDONE':
        case 'UNIT_CORRECTION_FILE_ENDED':
          change = { kind: 'CORRECTION', effectiveOn: null };
          break;
        case 'LANDLORD_TENANCY_ENDED':
        case 'LANDLORD_LINK_REVERTED':
          change = tenantEnding(after.tenantId);
          break;
        default:
          change = (FILE_ACTIONS as readonly string[]).includes(row.action)
            ? { kind: 'EDIT', effectiveOn: null }
            : null;
      }
    } else if (row.entityType === 'Building') {
      if (!(UNIT_ACTIONS as readonly string[]).includes(row.action)) continue;
      const named =
        [before.citizenId, after.citizenId, after.tenantId].includes(holder.citizenId) ||
        (Array.isArray(after.citizens) && after.citizens.includes(holder.citizenId));
      const unitCode = text(after.unitCode) ?? text(before.unitCode);
      // A reading of the whole building speaks for every flat in it, so for every holder.
      const wholeBuilding = row.action === 'DAMAGE_RECORDED' && !text(after.unitId);
      if (!named && !wholeBuilding && !(unitCode && holder.unitCodes.has(unitCode))) continue;

      switch (row.action) {
        case 'OCCUPANCY_ENDED':
          if (named && RECORDED_ON_FILE.has(String(after.via))) continue;
          change = byReason(text(after.reason), date(after.toDate));
          break;
        case 'UNIT_STATUS_AFTER_TENANCY':
          change = tenantEnding(after.tenantId);
          break;
        case 'UNIT_CORRECTION_DELETED':
          // The unit never existed: everything billed on it was a correction.
          change = { kind: 'CORRECTION', effectiveOn: null };
          break;
        case 'UNIT_FEE_EXEMPTION_SET':
          // Granted: the unit was exempt all along — see UNIT_ACTIONS.
          change = { kind: 'CORRECTION', effectiveOn: null };
          break;
        case 'DAMAGE_RECORDED':
        case 'UNIT_OWNER_BILLING_SET':
        case 'UNIT_FEE_EXEMPTION_LIFTED':
          change = { kind: 'DATED_CHANGE', effectiveOn: row.createdAt };
          break;
        case 'UNIT_VACANCY_ENDED':
          change = after.reason === 'RECORDED_IN_ERROR'
            ? { kind: 'CORRECTION', effectiveOn: null }
            : { kind: 'EDIT', effectiveOn: null };
          break;
        case 'UNIT_UPDATED': {
          const fields = Array.isArray(after.changedFields) ? after.changedFields.map(String) : null;
          if (fields && !fields.some((field) => BILLED_UNIT_FIELDS.has(field))) continue;
          change = { kind: 'EDIT', effectiveOn: null };
          break;
        }
        default:
          change = { kind: 'EDIT', effectiveOn: null };
      }
    }

    if (change) traced.push({ row, ...change });
  }
  return traced;
}

/**
 * Whether these changes, recorded since the bill was raised, make it a bill a
 * correction affected — anything but real changes that took effect after it.
 */
export function affectsBill(changes: readonly TracedChange[], raisedAt: Date): boolean {
  const raisedDay = Date.UTC(raisedAt.getUTCFullYear(), raisedAt.getUTCMonth(), raisedAt.getUTCDate());
  return changes.some(
    (change) =>
      change.kind !== 'DATED_CHANGE' ||
      (change.effectiveOn !== null && change.effectiveOn.getTime() <= raisedDay),
  );
}

/** A figure as one comparable string — what a review records having seen. */
export function figureKey(figure: BillFigure): string {
  return figure.kind === 'ASSESSED' ? `ASSESSED:${figure.amount}` : figure.kind;
}

/** What the bill says it charged for, against what the register holds now. */
export function linesDiff(
  billed: readonly FeeAssessmentLine[],
  now: readonly FeeAssessmentLine[],
): { removed: FeeAssessmentLine[]; added: FeeAssessmentLine[] } {
  // The owner's part is part of the line: a quarter of a shop is not the shop.
  const key = (line: FeeAssessmentLine) =>
    [
      line.propertyNumber ?? '',
      line.propertyType,
      line.unitType ?? '',
      line.unitArea ?? '',
      line.ownerShare ? `${line.ownerShare.numerator}/${line.ownerShare.denominator}` : '',
    ].join('|');
  const remaining = new Map<string, FeeAssessmentLine[]>();
  for (const line of now) {
    const list = remaining.get(key(line)) ?? [];
    list.push(line);
    remaining.set(key(line), list);
  }
  const removed: FeeAssessmentLine[] = [];
  for (const line of billed) {
    const match = remaining.get(key(line));
    if (match && match.length > 0) match.pop();
    else removed.push(line);
  }
  return { removed, added: [...remaining.values()].flat() };
}
