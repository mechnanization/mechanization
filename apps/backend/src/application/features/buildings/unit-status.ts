import {
  ar,
  describeUnitStatusConflict,
  isStructuralUnitType,
  settleUnitStatus,
  type SettledUnitStatus,
  type UnitStatusFacts,
} from '@mechanization/shared-schemas';
import type { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';

/**
 * «حالة الوحدة», kept in step with who is recorded in the flat — the database
 * half of `settleUnitStatus` (shared-schemas/unit-status-rule.ts).
 *
 * ## Why this exists
 *
 * Every action that changes who is in a flat, or what anyone says about it,
 * used to write the unit's status by its own rule, or not at all. Recording a
 * tenant filled the status only when it was empty, so a flat already marked
 * «مسكن موسمي» or «مشغولة من المالك» kept that and its owner went on paying
 * beside the tenant; ending a tenancy by unticking a card left «مؤجرة» on a
 * flat nobody was in, and the owner exempt. Each path was individually
 * reasonable. Together they let the unit card and the citizen's card say
 * different things about one flat, and billing read whichever it met first.
 *
 * So each of those actions now ends by calling `settleUnit`: it reads the facts
 * the rule needs, writes the status the rule decides, and keeps one
 * «تعارض في حالة الوحدة» case on the unit in step with what the rule could not
 * decide — opened when a conflict appears, closed when it goes. Billing reads
 * the same rule (`unitsUnderReview`) to hold the flat's occupancy fee while a
 * conflict stands.
 *
 * Functions over a Prisma client rather than a service, like `unit-vacancy.ts`
 * beside it, so the matrix, the census sync, the tenancy and ownership flows and
 * the landlord link can all call it — inside their own transaction when they
 * have one — without any of them depending on the others.
 */

export type UnitStatusDb = Pick<
  TenantPrismaClient,
  'unit' | 'unitOccupancy' | 'unitVacancyConfirmation' | 'buildingUnit' | 'propertyEntry' | 'registration' | 'case'
>;

/** An audit event the caller emits — after its transaction commits, when it has one. */
export interface UnitStatusEvent {
  channel: 'building.changed' | 'case.changed';
  payload: Record<string, unknown>;
}

export interface UnitStatusFactsRow extends UnitStatusFacts {
  unitId: string;
  unitCode: string;
  buildingId: string;
  /** The only unit of its structure — so a منزل card on it bills this flat. */
  soleUnitOfBuilding: boolean;
}

/** The label a status carries on screen, for case notes. */
const statusLabel = (status: string) =>
  (ar.unitStatus as Record<string, string>)[status] ?? status;

/**
 * The newest registration of each of these citizens — the one billing, the edit
 * form and the census sync read (`fees.service` `cur_reg`). An owner's statement
 * on an older filing is history, not what they say now.
 */
async function newestRegistrations(db: UnitStatusDb, citizenIds: string[]): Promise<Set<string>> {
  if (citizenIds.length === 0) return new Set();
  const rows = await db.registration.findMany({
    where: { citizenId: { in: citizenIds }, citizen: { isActive: true } },
    select: { id: true, citizenId: true, submittedAt: true },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
  });
  const newest = new Map<string, string>();
  for (const row of rows) if (!newest.has(row.citizenId)) newest.set(row.citizenId, row.id);
  return new Set(newest.values());
}

/**
 * The facts `settleUnitStatus` needs, for these units — or every non-structural
 * unit in the municipality when `unitIds` is omitted (billing, the quality scan,
 * «مراجعة حالة الوحدات»).
 *
 * Owner statements are read the way the census sync reads them: a line on a
 * current OWNER card naming the flat, or a current OWNER منزل card on a
 * structure with exactly one unit (`census-sync.service.ts`, the منزل branch).
 */
export async function loadUnitStatusFacts(
  db: UnitStatusDb,
  unitIds?: readonly string[],
): Promise<Map<string, UnitStatusFactsRow>> {
  const units = await db.unit.findMany({
    where: unitIds ? { id: { in: [...unitIds] } } : {},
    select: { id: true, unitCode: true, buildingId: true, unitType: true, unitStatus: true },
  });
  const occupiable = units.filter((unit) => !isStructuralUnitType(unit.unitType));
  const ids = occupiable.map((unit) => unit.id);
  const facts = new Map<string, UnitStatusFactsRow>();
  if (ids.length === 0) return facts;

  for (const unit of occupiable) {
    facts.set(unit.id, {
      unitId: unit.id,
      unitCode: unit.unitCode,
      buildingId: unit.buildingId,
      current: unit.unitStatus ?? null,
      standingVacancy: false,
      liveRoles: [],
      ownerStatements: [],
      soleUnitOfBuilding: false,
    });
  }

  const [vacancies, spells, lines] = await Promise.all([
    db.unitVacancyConfirmation.findMany({
      where: { unitId: { in: ids }, endedAt: null },
      select: { unitId: true },
    }),
    db.unitOccupancy.findMany({
      where: { unitId: { in: ids }, toDate: null },
      select: { unitId: true, role: true },
    }),
    db.buildingUnit.findMany({
      where: {
        unitId: { in: ids },
        endedAt: null,
        propertyEntry: { occupancyType: 'OWNER' as never, endedAt: null },
      },
      select: {
        unitId: true,
        unitStatus: true,
        propertyEntry: { select: { registrationId: true, registration: { select: { citizenId: true } } } },
      },
    }),
  ]);

  for (const row of vacancies) {
    const fact = facts.get(row.unitId);
    if (fact) fact.standingVacancy = true;
  }
  for (const row of spells) {
    const fact = facts.get(row.unitId);
    if (fact) (fact.liveRoles as string[]).push(row.role);
  }

  // منزل cards on single-unit structures: the card is the statement about its one flat.
  const buildingIds = [...new Set(occupiable.map((unit) => unit.buildingId))];
  const singleUnit = new Map<string, string>();
  if (buildingIds.length > 0) {
    const counts = await db.unit.groupBy({
      by: ['buildingId'],
      where: { buildingId: { in: buildingIds } },
      _count: { _all: true },
    });
    const single = new Set(counts.filter((row) => row._count._all === 1).map((row) => row.buildingId));
    for (const unit of occupiable) {
      if (!single.has(unit.buildingId)) continue;
      singleUnit.set(unit.buildingId, unit.id);
      facts.get(unit.id)!.soleUnitOfBuilding = true;
    }
  }
  const houses =
    singleUnit.size === 0
      ? []
      : await db.propertyEntry.findMany({
          where: {
            buildingId: { in: [...singleUnit.keys()] },
            propertyType: 'HOUSE' as never,
            occupancyType: 'OWNER' as never,
            endedAt: null,
            units: { none: { endedAt: null } },
          },
          select: {
            buildingId: true,
            unitStatus: true,
            registrationId: true,
            registration: { select: { citizenId: true } },
          },
        });

  const citizens = [
    ...new Set([
      ...lines.map((line) => line.propertyEntry.registration.citizenId),
      ...houses.map((card) => card.registration.citizenId),
    ]),
  ];
  const current = await newestRegistrations(db, citizens);

  for (const line of lines) {
    if (!line.unitId || !current.has(line.propertyEntry.registrationId)) continue;
    const fact = facts.get(line.unitId);
    if (fact) (fact.ownerStatements as (string | null)[]).push(line.unitStatus ?? null);
  }
  for (const card of houses) {
    if (!card.buildingId || !current.has(card.registrationId)) continue;
    const unitId = singleUnit.get(card.buildingId);
    const fact = unitId ? facts.get(unitId) : undefined;
    if (fact) (fact.ownerStatements as (string | null)[]).push(card.unitStatus ?? null);
  }

  return facts;
}

/**
 * The units the rule has something to say about right now: a conflict stands
 * (its occupancy fee is held), or the stored status is not yet what the rule
 * decides (a flat nobody has touched since this rule shipped — billing charges
 * by the rule's status, not the stale one, and «مراجعة حالة الوحدات» writes it).
 *
 * Read by billing once per run and by the quality scan; recomputed each time,
 * so a flat fixed through any screen drops out without anyone closing anything.
 */
export async function unitsUnderReview(
  db: UnitStatusDb,
  unitIds?: readonly string[],
): Promise<Map<string, SettledUnitStatus & UnitStatusFactsRow>> {
  const facts = await loadUnitStatusFacts(db, unitIds);
  const held = new Map<string, SettledUnitStatus & UnitStatusFactsRow>();
  for (const fact of facts.values()) {
    const settled = settleUnitStatus(fact);
    if (settled.conflicts.length > 0 || settled.status !== fact.current) {
      held.set(fact.unitId, { ...fact, ...settled });
    }
  }
  return held;
}

export interface SettleOutcome {
  unitId: string;
  before: string | null;
  after: string | null;
  conflicts: SettledUnitStatus['conflicts'];
  caseOpened: boolean;
  casesResolved: number;
  events: UnitStatusEvent[];
}

/**
 * Brings one unit into line with the rule, and its «تعارض» case with it.
 *
 * Returns the audit events rather than emitting them, so a caller inside a
 * transaction emits them only once it commits. Returns null for a unit that no
 * longer exists or cannot hold an occupant.
 */
export async function settleUnit(
  db: UnitStatusDb,
  input: {
    unitId: string;
    tenantSlug: string | undefined;
    actor: { id: string; role: string };
    /** Which action this settles after — goes in the audit row. */
    via: string;
  },
): Promise<SettleOutcome | null> {
  const facts = (await loadUnitStatusFacts(db, [input.unitId])).get(input.unitId);
  if (!facts) return null;

  const settled = settleUnitStatus(facts);
  const events: UnitStatusEvent[] = [];

  if (settled.status !== facts.current) {
    await db.unit.update({
      where: { id: input.unitId },
      data: { unitStatus: settled.status as never },
    });
    events.push({
      channel: 'building.changed',
      payload: {
        tenantSlug: input.tenantSlug,
        action: 'UNIT_UPDATED',
        buildingId: facts.buildingId,
        before: { unitCode: facts.unitCode, unitStatus: facts.current },
        after: {
          unitCode: facts.unitCode,
          unitStatus: settled.status,
          changedFields: ['unitStatus'],
          via: input.via,
          rule: 'SETTLED',
        },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      },
    });
  }

  const open = await db.case.findMany({
    where: { unitId: input.unitId, caseType: 'STATUS_CONFLICT' as never, status: { in: ['OPEN', 'SCHEDULED'] as never } },
    select: { id: true, notes: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  let caseOpened = false;
  let casesResolved = 0;

  if (settled.conflicts.length > 0) {
    const notes = settled.conflicts
      .map((conflict) => describeUnitStatusConflict(conflict, statusLabel))
      .join('\n');
    if (open.length === 0) {
      const building = await db.unit.findUnique({
        where: { id: input.unitId },
        select: { building: { select: { parcelNumber: true } } },
      });
      const created = await db.case.create({
        data: {
          notes: `الوحدة ${facts.unitCode}: ${notes}`,
          caseType: 'STATUS_CONFLICT' as never,
          buildingId: facts.buildingId,
          unitId: input.unitId,
          propertyNumber: building?.building.parcelNumber ?? null,
          createdById: input.actor.id,
        },
        select: { id: true },
      });
      caseOpened = true;
      events.push({
        channel: 'case.changed',
        payload: {
          caseId: created.id,
          action: 'CASE_CREATED',
          after: { caseType: 'STATUS_CONFLICT', unitCode: facts.unitCode, conflicts: settled.conflicts, via: input.via },
          actorId: input.actor.id,
          actorRole: input.actor.role,
        },
      });
    }
  } else if (open.length > 0) {
    const resolved = await db.case.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: { status: 'RESOLVED' as never, resolvedAt: new Date() },
    });
    casesResolved = resolved.count;
    for (const row of open) {
      events.push({
        channel: 'case.changed',
        payload: {
          caseId: row.id,
          action: 'CASE_RESOLVED',
          before: { status: row.status },
          after: { status: 'RESOLVED', via: 'STATUS_SETTLED', settledBy: input.via },
          actorId: input.actor.id,
          actorRole: input.actor.role,
        },
      });
    }
  }

  return {
    unitId: input.unitId,
    before: facts.current,
    after: settled.status,
    conflicts: settled.conflicts,
    caseOpened,
    casesResolved,
    events,
  };
}
