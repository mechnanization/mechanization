import type { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import type { VacancyRow } from './building.types';

/**
 * «تأكيد الشغور» — the parts every door onto it shares.
 *
 * Three services reach this fact. `BuildingsService` confirms and lifts it from
 * the matrix, `CensusSyncService` lifts it when a registration puts a household
 * into the flat, and `recordOccupancy` lifts it when an officer links a tenant
 * from the drawer. They must agree about what "a vacancy is standing" means and
 * about what the unit goes back to when one ends, or the same flat ends up in a
 * different state depending on which screen the officer used — which is the
 * class of drift D15 is about.
 *
 * Kept as functions over a Prisma client rather than a service, so the two
 * services can call them without either depending on the other (that is how an
 * import cycle starts) and without a fourth constructor argument in
 * `BuildingsService`, whose specs all build it by hand.
 */

/** Just the delegates these helpers touch, so a transaction client fits too. */
export type VacancyDb = Pick<TenantPrismaClient, 'unitVacancyConfirmation' | 'unitVisit'>;

/** The confirmation standing on a unit right now, or null. */
export async function activeVacancy(db: VacancyDb, unitId: string) {
  return db.unitVacancyConfirmation.findFirst({
    where: { unitId, endedAt: null },
    orderBy: { observedAt: 'desc' },
  });
}

/**
 * What a unit should say once a vacancy is lifted — the whole of the undo's
 * reasoning, kept pure so it can be tested without a database.
 *
 * ## Only what the confirmation itself wrote
 *
 * A unit whose status has moved on since — an owner's card answered «مؤجرة», a
 * later visit found it demolished — is not walked backwards. The confirmation
 * wrote exactly two values, and this restores exactly the ones still holding
 * them; anything else is a newer statement about the flat and the undo has no
 * business overruling it. That is what makes "undo at any time" safe rather
 * than destructive: the later the undo, the less of it applies.
 *
 * ## The two reasons restore different things
 *
 * `RECORDED_IN_ERROR` — the flat was never empty, so the unit returns to what
 * it said before: the snapshot the confirmation stored. Null there means either
 * "nothing was set" or "this row was backfilled by 0043 and nobody knows", and
 * both land on the same honest answer — «غير محدد», a unit billed to its owner
 * because the question is open again.
 *
 * `NO_LONGER_VACANT` — it was empty and somebody has moved in. The حالة goes to
 * null rather than back to the snapshot, because whatever the flat was *before*
 * the vacancy is not what it is now; and the survey status goes to `PARTIAL`,
 * which says precisely what is true — the unit has been seen, it is occupied,
 * and who is in it has not been recorded yet. Recording them is what lifts it
 * to `COMPLETE`, through the same narrow gate every other occupancy uses.
 *
 * ## The survey fallback
 *
 * A backfilled row has no `previousSurveyStatus`, and `NOT_SURVEYED` would be a
 * lie on a flat officers have visited — it means nobody went. So the unit falls
 * back to the outcome of its last real visit, and only to `NOT_SURVEYED` when
 * there has genuinely never been one.
 */
export function vacancyReversal(input: {
  reason: 'RECORDED_IN_ERROR' | 'NO_LONGER_VACANT';
  /** The unit as it stands now. */
  unit: { unitStatus: string | null; surveyStatus: string };
  confirmation: { previousUnitStatus: string | null; previousSurveyStatus: string | null };
  /** The outcome of the unit's last visit that was not itself the vacancy. */
  lastVisitOutcome: string | null;
}): { unitStatus?: string | null; surveyStatus?: string } {
  const restore: { unitStatus?: string | null; surveyStatus?: string } = {};

  if (input.unit.unitStatus === 'VACANT') {
    restore.unitStatus =
      input.reason === 'RECORDED_IN_ERROR' ? (input.confirmation.previousUnitStatus ?? null) : null;
  }

  if (input.unit.surveyStatus === 'VACANT_CONFIRMED') {
    if (input.reason === 'NO_LONGER_VACANT') {
      restore.surveyStatus = 'PARTIAL';
    } else {
      const previous = input.confirmation.previousSurveyStatus;
      restore.surveyStatus =
        previous && previous !== 'VACANT_CONFIRMED'
          ? previous
          : (input.lastVisitOutcome ?? 'NOT_SURVEYED');
    }
  }

  return restore;
}

/**
 * Closes the confirmation standing on a unit, and says what the unit should
 * now read — leaving the caller to write it in whatever transaction it is
 * already running.
 *
 * Returns null when no vacancy is standing, which is the ordinary case on
 * nearly every unit: callers use that to skip the work entirely.
 */
export async function closeActiveVacancy(
  db: VacancyDb,
  input: {
    unitId: string;
    unit: { unitStatus: string | null; surveyStatus: string };
    reason: 'RECORDED_IN_ERROR' | 'NO_LONGER_VACANT';
    endedAt?: Date;
    notes?: string;
    actorId: string | null;
  },
): Promise<{
  confirmation: Awaited<ReturnType<typeof activeVacancy>>;
  restore: { unitStatus?: string | null; surveyStatus?: string };
} | null> {
  const confirmation = await activeVacancy(db, input.unitId);
  if (!confirmation) return null;

  /*
    A vacancy cannot end before it was observed. Clamped rather than refused,
    because the callers that reach this helper are not asking a question — a
    tenant has just been recorded — and failing their write over a date would
    lose the occupancy to protect a timestamp. The service-level undo, where a
    person typed the date, refuses it instead.
  */
  const requested = input.endedAt ?? new Date();
  const endedAt = requested < confirmation.observedAt ? confirmation.observedAt : requested;

  const lastVisit = await db.unitVisit.findFirst({
    where: { unitId: input.unitId, outcome: { not: 'VACANT_CONFIRMED' as never } },
    orderBy: [{ visitedAt: 'desc' }, { createdAt: 'desc' }],
    select: { outcome: true },
  });

  const closed = await db.unitVacancyConfirmation.update({
    where: { id: confirmation.id },
    data: {
      endedAt,
      endReason: input.reason as never,
      endNotes: input.notes?.trim() || null,
      endedById: input.actorId,
    },
  });

  return {
    confirmation: closed,
    restore: vacancyReversal({
      reason: input.reason,
      unit: input.unit,
      confirmation,
      lastVisitOutcome: lastVisit?.outcome ?? null,
    }),
  };
}

export function toVacancyRow(row: {
  id: string;
  unitId: string;
  basis: string | null;
  observedAt: Date;
  notes: string | null;
  confirmedById: string | null;
  confirmedBy?: { firstName: string | null; lastName: string | null } | null;
  previousUnitStatus: string | null;
  previousSurveyStatus: string | null;
  endedAt: Date | null;
  endReason: string | null;
  endNotes: string | null;
  endedById: string | null;
  endedBy?: { firstName: string | null; lastName: string | null } | null;
  createdAt: Date;
}): VacancyRow {
  const name = (person?: { firstName: string | null; lastName: string | null } | null) =>
    person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || null : null;

  return {
    id: row.id,
    unitId: row.unitId,
    basis: row.basis,
    observedAt: row.observedAt,
    notes: row.notes,
    confirmedById: row.confirmedById,
    confirmedByName: name(row.confirmedBy),
    previousUnitStatus: row.previousUnitStatus,
    previousSurveyStatus: row.previousSurveyStatus,
    endedAt: row.endedAt,
    endReason: row.endReason,
    endNotes: row.endNotes,
    endedById: row.endedById,
    endedByName: name(row.endedBy),
    createdAt: row.createdAt,
  };
}
