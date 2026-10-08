import {
  contactDetailsSchema,
  isDwellingUnitType,
  isOwnerRecord,
  nonResidentCardIssues,
  personalDetailsSchema,
  splitInstitutionName,
  type CitizenResidence,
  type UnitStatus,
} from '@mechanization/shared-schemas';
import type { CitizenFormValues } from '@/components/admin/citizen-form';

/**
 * «تغيير الإقامة» — what a real move into or out of the town has to settle on
 * a file, worked out from the edit form's own values.
 *
 * Moving out of the town turns a household into «غير مقيم في البلدة», and that
 * record refuses three things a household may well hold (`nonResidentCardIssues`,
 * the one statement of the rule — read here, not restated):
 *
 *  - renting or occupying somewhere people live: the move ended it, so the
 *    tenancy is ended on its day (the card's own «إنهاء الإيجار»);
 *  - renting something whose type is unknown: the officer says what it is;
 *  - a home they own marked «مشغولة من المالك»: it becomes «مسكن موسمي»,
 *    «شاغرة», or whoever lives there now.
 *
 * Someone left holding nothing here does not become a non-resident record at
 * all: their file is deactivated (decision of 2026-09-27).
 *
 * Moving back is lighter: which of their own homes they live in now, if any,
 * and the household questions the file will ask from now on.
 *
 * A death is the same settling, toward «تركة» (0076): the estate owns and
 * nothing else, so every tenancy ends with the person, a home they lived in
 * becomes whoever lives there now — the family, as «مشغولة بتسامح», with one
 * of them filed as a household — and a file left owning nothing is archived.
 */
export interface MoveHome {
  /** `card:<i>` for a منزل, `row:<i>:<u>` for a flat on a مبنى card. */
  key: string;
  cardIndex: number;
  unitIndex: number | null;
  propertyNumber: string | null;
  propertyType: string | null;
  unitType: string | null;
  floor: string | null;
  status: UnitStatus | null;
}

export interface ResidenceMovePlan {
  to: CitizenResidence;
  /** Tenancies of somewhere people live — they end with the move. */
  tenancies: Array<{ cardIndex: number; cardId: string | null; propertyNumber: string | null; propertyType: string | null }>;
  /** What they rent, of a type nobody has said. */
  needsUnitType: Array<{ cardIndex: number; propertyNumber: string | null }>;
  /**
   * Moving out: homes they own and are marked as living in — each needs another
   * status. Moving back: homes they own that nobody else is recorded in — where
   * they may be living now.
   */
  homes: MoveHome[];
  /** Once those tenancies end, nothing is left here: deactivate, do not switch. */
  nothingLeft: boolean;
  /** Household questions the file will ask once it is a household again. */
  householdMissing: string[];
}

/** The statuses a home can take when its owner no longer lives in the town. */
export const AWAY_HOME_STATUSES = ['SEASONAL', 'VACANT', 'RENTED', 'FREE_OCCUPIED'] as const satisfies readonly UnitStatus[];

/** …and when its owner has died: nobody comes back for a season. The family staying is «مشغولة بتسامح». */
export const ESTATE_HOME_STATUSES = ['FREE_OCCUPIED', 'RENTED', 'VACANT'] as const satisfies readonly UnitStatus[];

/** What each home can become on a move or a death to `to`. */
export function homeStatusesFor(to: CitizenResidence): readonly UnitStatus[] {
  return to === 'ESTATE' ? ESTATE_HOME_STATUSES : AWAY_HOME_STATUSES;
}

const OCCUPIED_BY_SOMEONE_ELSE: ReadonlySet<string> = new Set(['RENTED', 'FREE_OCCUPIED']);

export function planResidenceMove(values: CitizenFormValues, to: CitizenResidence): ResidenceMovePlan {
  const plan: ResidenceMovePlan = { to, tenancies: [], needsUnitType: [], homes: [], nothingLeft: false, householdMissing: [] };
  const flagged = new Set(values.flags.keys());

  if (isOwnerRecord(to)) {
    let remaining = 0;
    values.properties.forEach((card, cardIndex) => {
      const issues = nonResidentCardIssues(card as Record<string, unknown>, flagged, `properties.${cardIndex}`, to);
      const where = { cardIndex, propertyNumber: card.propertyNumber?.trim() || null };
      // An estate holds no tenancy at all; anyone else none of somewhere people live.
      const ownsOnly = issues.some((issue) => issue.code === 'ESTATE_OWNS_ONLY');
      const dwelling = issues.filter((issue) => issue.code === 'DWELLING');
      if (ownsOnly || dwelling.length > 0) {
        plan.tenancies.push({ ...where, cardId: card.id ?? null, propertyType: card.propertyType ?? null });
      }
      if (issues.some((issue) => issue.code === 'NEEDS_UNIT_TYPE')) plan.needsUnitType.push(where);
      for (const issue of issues.filter((found) => found.code === 'OWNER_LIVES_THERE')) {
        const unitIndex = issue.path[0] === 'units' ? Number(issue.path[1]) : null;
        plan.homes.push(homeOf(values, cardIndex, unitIndex));
      }
      /*
        What stays once the tenancy ends: a card whose every line is somewhere
        people live goes with the move; a card that also holds a shop keeps it.
      */
      const units = card.units ?? [];
      const wholeCardGoes =
        ownsOnly ||
        (dwelling.length > 0 && (card.propertyType !== 'BUILDING' || dwelling.length === units.length));
      if (!wholeCardGoes) remaining += 1;
    });
    plan.nothingLeft = remaining === 0;
    return plan;
  }

  values.properties.forEach((card, cardIndex) => {
    if (card.occupancyType !== 'OWNER') return;
    if (card.propertyType === 'HOUSE') {
      if (!OCCUPIED_BY_SOMEONE_ELSE.has(card.unitStatus ?? '')) plan.homes.push(homeOf(values, cardIndex, null));
      return;
    }
    if (card.propertyType !== 'BUILDING') return;
    (card.units ?? []).forEach((unit, unitIndex) => {
      if (isDwellingUnitType(unit.unitType) && !OCCUPIED_BY_SOMEONE_ELSE.has(unit.unitStatus ?? '')) {
        plan.homes.push(homeOf(values, cardIndex, unitIndex));
      }
    });
  });

  const missing = new Set<string>();
  const collect = (section: 'personal' | 'contact', result: { success: boolean; error?: { issues: Array<{ path: Array<string | number> }> } }) => {
    if (result.success) return;
    for (const issue of result.error?.issues ?? []) {
      const field = String(issue.path[0] ?? '');
      if (field && !flagged.has(`${section}.${field}`)) missing.add(field);
    }
  };
  collect('personal', personalDetailsSchema.safeParse(values.personal));
  collect('contact', contactDetailsSchema.safeParse(values.contact));
  plan.householdMissing = [...missing];
  return plan;
}

function homeOf(values: CitizenFormValues, cardIndex: number, unitIndex: number | null): MoveHome {
  const card = values.properties[cardIndex]!;
  const unit = unitIndex === null ? null : (card.units ?? [])[unitIndex] ?? null;
  return {
    key: unitIndex === null ? `card:${cardIndex}` : `row:${cardIndex}:${unitIndex}`,
    cardIndex,
    unitIndex,
    propertyNumber: card.propertyNumber?.trim() || null,
    propertyType: card.propertyType ?? null,
    unitType: unit ? (unit.unitType ?? null) : null,
    floor: unit ? (unit.floor ?? null) : null,
    status: ((unit ? unit.unitStatus : card.unitStatus) ?? null) as UnitStatus | null,
  };
}

export interface ResidenceMoveAnswers {
  /** `YYYY-MM-DD` — the day the move took effect. */
  movedOn: string;
  /** Why, in the officer's words; the save's «سبب التعديل» starts from it. */
  reason: string;
  /** Moving out: where they live now. */
  residencePlace?: string;
  /** Moving out: each home's new status, by `MoveHome.key`. */
  homeStatuses?: Record<string, UnitStatus>;
  /** Moving back: the home they live in now, or null for somewhere else in the town. */
  livesIn?: string | null;
}

/**
 * The form's values with the move applied — nothing is saved. The officer
 * reviews it with everything else and saves as ever, and the save carries
 * `movedOn` (see `toSubmission`).
 */
export function applyResidenceMove(
  values: CitizenFormValues,
  plan: ResidenceMovePlan,
  answers: ResidenceMoveAnswers,
): CitizenFormValues {
  const statusFor = new Map<string, UnitStatus>();
  if (isOwnerRecord(plan.to)) {
    for (const home of plan.homes) {
      const status = answers.homeStatuses?.[home.key];
      if (status) statusFor.set(home.key, status);
    }
  } else if (answers.livesIn) {
    statusFor.set(answers.livesIn, 'OWNER_OCCUPIED');
  }

  const properties = values.properties.map((card, cardIndex) => {
    const own = statusFor.get(`card:${cardIndex}`);
    const units = card.units?.map((unit, unitIndex) => {
      const status = statusFor.get(`row:${cardIndex}:${unitIndex}`);
      return status ? { ...unit, unitStatus: status } : unit;
    });
    return { ...card, ...(own ? { unitStatus: own } : {}), ...(units ? { units } : {}) };
  });

  return {
    ...values,
    residence: plan.to,
    personal:
      plan.to === 'NON_RESIDENT_OWNER'
        ? { ...values.personal, residencePlace: answers.residencePlace?.trim() ?? '' }
        : values.personal,
    properties,
    residenceMove: { movedOn: answers.movedOn, reason: answers.reason.trim() },
  };
}

/** A person's name parts, kept while the file is an institution — see `namesForKind`. */
export interface NamesBefore {
  firstName: string;
  middleName: string;
  lastName: string;
  /** The one line they were joined into; restored only while it still reads so. */
  joined: string;
}

/**
 * The name boxes across a change of record kind (0076). An institution's name
 * is one line («وقف مسجد البلدة»), a person's or an estate's three boxes:
 * joined on the way in, and on the way out restored from `before` when the
 * line is still what they were joined into — a switch made by mistake and
 * undone loses nothing — or else split by the API's own rule
 * (`splitInstitutionName`). Nothing typed is lost to a box the form hides.
 */
export function namesForKind(
  personal: Record<string, unknown>,
  from: CitizenResidence,
  to: CitizenResidence,
  before?: NamesBefore,
): { personal: Record<string, unknown>; before?: NamesBefore } {
  const part = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  if (to === 'INSTITUTION' && from !== 'INSTITUTION') {
    const parts = { firstName: part(personal.firstName), middleName: part(personal.middleName), lastName: part(personal.lastName) };
    const joined = [parts.firstName, parts.middleName, parts.lastName].filter(Boolean).join(' ');
    return {
      personal: { ...personal, firstName: joined, middleName: '', lastName: '' },
      before: { ...parts, joined },
    };
  }
  if (from === 'INSTITUTION' && to !== 'INSTITUTION') {
    const line = part(personal.firstName);
    if (before && before.joined === line) {
      const { joined: _joined, ...parts } = before;
      return { personal: { ...personal, ...parts } };
    }
    const { firstName, lastName } = splitInstitutionName(line);
    return { personal: { ...personal, firstName, middleName: '', lastName } };
  }
  return { personal, before };
}
