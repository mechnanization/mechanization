import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  calendarDayOf,
  citizenDisplayName,
  EASTERN_DIGITS,
  FEE_EXEMPTION_LIFT_REASON_MIN,
  formatFullUnitReference,
  isFeeExemptOn,
  isStructuralUnitType,
  LATIN_DIGITS,
  municipalToday,
  normalizeDigits,
  type FeeExemptionCitizenUnits,
  type FeeExemptionHolder,
  type FeeExemptionListItem,
  type FeeExemptionListQuery,
  type FeeExemptionListResult,
  type FeeExemptionPeriodView,
  type FeeExemptionReason,
  type FeeExemptionUnitView,
  type OccupancyRole,
  type SetUnitFeeExemptionInput,
  type UnitType,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { citizenSearchText } from '../../common/citizen-search';
import { NotFoundError, ValidationError } from '../../common/exceptions';
import { likePattern, searchTokens } from '../../common/search-terms';
import { AuditService, type BuildingChange } from '../audit/audit.service';
import { setLocalLockTimeout } from '../../common/lock-timeout';

/** The audit actions, and the names «فواتير تأثّرت بتصحيحات» traces them by. */
export const UNIT_FEE_EXEMPTION_SET = 'UNIT_FEE_EXEMPTION_SET';
export const UNIT_FEE_EXEMPTION_LIFTED = 'UNIT_FEE_EXEMPTION_LIFTED';

/**
 * The lift reason written on a period the build before 0104 left open after it
 * lifted the unit's exemption, so the history says why it closed without a
 * person's reason. Stored as is; shown as is.
 */
export const RECONCILED_LIFT_REASON = 'رُفع الإعفاء قبل أن يُحفظ سجلّه (مطابقة تلقائية)';

const PERIOD_SELECT = {
  id: true,
  reason: true,
  note: true,
  decisionRef: true,
  validUntil: true,
  grantedAt: true,
  liftedAt: true,
  liftReason: true,
  grantedBy: { select: { id: true, firstName: true, lastName: true } },
  liftedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.UnitFeeExemptionSelect;

type PeriodRow = {
  id: string;
  reason: string;
  note: string | null;
  decisionRef: string | null;
  validUntil: Date | null;
  grantedAt: Date;
  liftedAt: Date | null;
  liftReason: string | null;
  grantedBy: { id: string; firstName: string; lastName: string } | null;
  liftedBy: { id: string; firstName: string; lastName: string } | null;
};

const UNIT_VIEW_SELECT = {
  id: true,
  unitCode: true,
  unitType: true,
  unitArea: true,
  feeExemption: true,
  feeExemptionValidUntil: true,
  building: { select: { id: true, code: true, name: true, parcelNumber: true } },
  // Who holds it now, on an open file: the people billing would charge for it.
  occupancies: {
    where: { toDate: null, citizen: { isActive: true } },
    orderBy: [{ role: 'asc' as const }, { fromDate: 'asc' as const }],
    select: {
      role: true,
      citizen: { select: { id: true, firstName: true, middleName: true, lastName: true, residence: true } },
    },
  },
  feeExemptionPeriods: { orderBy: [{ grantedAt: 'desc' as const }], select: PERIOD_SELECT },
} satisfies Prisma.UnitSelect;

type UnitViewRow = {
  id: string;
  unitCode: string;
  unitType: string | null;
  unitArea: { toString(): string } | null;
  feeExemption: string | null;
  feeExemptionValidUntil: Date | null;
  building: { id: string; code: string; name: string | null; parcelNumber: string };
  occupancies: Array<{
    role: string;
    citizen: { id: string; firstName: string; middleName: string | null; lastName: string; residence: string | null };
  }>;
  feeExemptionPeriods: PeriodRow[];
};

/**
 * «معفاة من الرسوم» and «قائمة الإعفاء من الرسوم» — granting, amending and
 * lifting a unit's exemption from every fee, and the whitelist of exempt units
 * (migrations 0077 and 0104; the user's decisions of 2026-10-07 and
 * 2026-11-16).
 *
 * The exemption belongs to a **unit**, never to a person: the mosque on a waqf
 * parcel is exempt, the shop the waqf rents out is billed to its tenant. The
 * unit's `feeExemption*` columns are the live state every billing reader asks
 * (`isFeeExemptOn`); `unit_fee_exemptions` is their history, one row per
 * period, written in the same transaction.
 *
 * Writes are SUPER_ADMIN only (the route says so): an exemption takes a unit
 * off every bill, for every person who holds it. Tier 1 — the audit row is
 * written inside the transaction and names everyone on the unit by id, so
 * «فواتير تأثّرت بتصحيحات» reaches each one's bill. The row carries the
 * reason, the decision number, the last day and a lift's reason; never the
 * note, and never a name (decision 6 of 2026-11-16).
 *
 * Reads name the people on the units, so they are staff only, for
 * `FEE_EXEMPTION_READ_ROLES`; never the portal.
 */
@Injectable()
export class FeeExemptionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditTrail: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /**
   * Grant (`reason` set) or lift (`reason` null) a unit's exemption.
   *
   * Saving an exempt unit again amends its open period — the reason, the note,
   * the decision number, the last day — and keeps who granted it and when. A
   * lift closes the open period with its reason; the next grant opens a new one.
   * Saving what is already recorded writes nothing.
   */
  async set(
    unitId: string,
    input: SetUnitFeeExemptionInput,
    actor: { id: string; role: string },
  ): Promise<FeeExemptionUnitView> {
    const today = municipalToday();
    const change = await runInTenantTransaction(this.tenantContext, async () => {
      await setLocalLockTimeout(this.db);
      await this.db.$queryRaw`SELECT "id" FROM ${this.S}"units" WHERE "id" = ${unitId}::uuid FOR UPDATE`;

      const unit = await this.db.unit.findUnique({
        where: { id: unitId },
        select: {
          id: true,
          buildingId: true,
          unitCode: true,
          unitType: true,
          feeExemption: true,
          feeExemptionNote: true,
          feeExemptionValidUntil: true,
          feeExemptedAt: true,
          feeExemptedById: true,
          occupancies: { where: { toDate: null }, select: { citizenId: true } },
        },
      });
      if (!unit) throw new NotFoundError({ code: 'UNIT_NOT_FOUND', message: 'This unit could not be found.' });

      // A structural floor is never billed: there is nothing to exempt it from.
      if (input.reason !== null && isStructuralUnitType(unit.unitType)) {
        throw new ValidationError({
          code: 'FEE_EXEMPTION_STRUCTURAL_UNIT',
          message: 'A structural floor is never billed, so it cannot be exempted.',
          params: { unitCode: unit.unitCode },
        });
      }
      const validUntil = input.reason === null ? null : (input.validUntil ?? null);
      if (validUntil !== null && validUntil < today) {
        throw new ValidationError({
          code: 'FEE_EXEMPTION_VALID_UNTIL_PAST',
          message: 'The last exempt day is before today.',
          params: { validUntil, today },
        });
      }
      const liftReason = input.liftReason?.trim() ?? '';
      if (input.reason === null && liftReason.length < FEE_EXEMPTION_LIFT_REASON_MIN) {
        // The route's schema refuses it first; a caller inside the server skips the schema.
        throw new ValidationError({ code: 'FEE_EXEMPTION_LIFT_REASON_REQUIRED', message: 'A lift needs its reason.' });
      }

      const at = new Date();
      const open = await this.reconciledOpenPeriod(unit, at);

      const note = input.reason === null ? null : input.note?.trim() || null;
      const decisionRef = input.reason === null ? null : input.decisionRef?.trim() || null;
      const citizens = [...new Set(unit.occupancies.map((spell) => spell.citizenId))];
      const before = {
        unitId: unit.id,
        unitCode: unit.unitCode,
        feeExemption: unit.feeExemption,
        ...(open
          ? {
              periodId: open.id,
              decisionRef: open.decisionRef,
              validUntil: open.validUntil ? calendarDayOf(open.validUntil) : null,
            }
          : {}),
      };

      if (input.reason === null) {
        if (unit.feeExemption === null) return { audited: null };
        await this.db.unitFeeExemption.update({
          where: { id: open!.id },
          data: { liftedAt: at, liftedById: actor.id, liftReason },
        });
        await this.db.unit.update({
          where: { id: unit.id },
          data: {
            feeExemption: null,
            feeExemptionNote: null,
            feeExemptionValidUntil: null,
            feeExemptedById: null,
            feeExemptedAt: null,
          },
        });
        return {
          audited: await this.audit(UNIT_FEE_EXEMPTION_LIFTED, unit.buildingId, actor, before, {
            unitId: unit.id,
            unitCode: unit.unitCode,
            feeExemption: null,
            periodId: open!.id,
            liftReason,
            citizens,
          }),
        };
      }

      const unchanged =
        open !== null &&
        unit.feeExemption === input.reason &&
        (unit.feeExemptionNote ?? null) === note &&
        open.decisionRef === decisionRef &&
        (open.validUntil ? calendarDayOf(open.validUntil) : null) === validUntil;
      if (unchanged) return { audited: null };

      const validUntilDate = validUntil === null ? null : new Date(`${validUntil}T00:00:00.000Z`);
      const period = open
        ? await this.db.unitFeeExemption.update({
            where: { id: open.id },
            data: { reason: input.reason as never, note, decisionRef, validUntil: validUntilDate },
            select: { id: true },
          })
        : await this.db.unitFeeExemption.create({
            data: {
              unitId: unit.id,
              reason: input.reason as never,
              note,
              decisionRef,
              validUntil: validUntilDate,
              grantedById: actor.id,
              grantedAt: at,
            },
            select: { id: true },
          });
      await this.db.unit.update({
        where: { id: unit.id },
        data: open
          ? { feeExemption: input.reason as never, feeExemptionNote: note, feeExemptionValidUntil: validUntilDate }
          : {
              feeExemption: input.reason as never,
              feeExemptionNote: note,
              feeExemptionValidUntil: validUntilDate,
              feeExemptedById: actor.id,
              feeExemptedAt: at,
            },
      });
      return {
        audited: await this.audit(UNIT_FEE_EXEMPTION_SET, unit.buildingId, actor, before, {
          unitId: unit.id,
          unitCode: unit.unitCode,
          feeExemption: input.reason,
          periodId: period.id,
          decisionRef,
          validUntil,
          // Everyone on the unit now, so «فواتير تأثّرت بتصحيحات» reaches each one's bill.
          citizens,
        }),
      };
    });

    if (change.audited) this.events.emit('building.changed', { ...change.audited, alreadyAudited: true });
    return this.unitView(unitId);
  }

  /**
   * The open period of a unit whose row is locked, after making it agree with
   * the unit's live columns. The build before 0104 granted and lifted through
   * the columns alone, so after 0104 ran it could leave an exempt unit with no
   * open period (a grant) or an open period on a unit billed normally (a lift).
   * The first gets the period the backfill would have written; the second is
   * closed with `RECONCILED_LIFT_REASON`, by nobody.
   */
  private async reconciledOpenPeriod(
    unit: {
      id: string;
      feeExemption: string | null;
      feeExemptionNote: string | null;
      feeExemptionValidUntil: Date | null;
      feeExemptedAt: Date | null;
      feeExemptedById: string | null;
    },
    at: Date,
  ): Promise<{ id: string; decisionRef: string | null; validUntil: Date | null } | null> {
    const select = { id: true, decisionRef: true, validUntil: true, grantedAt: true } as const;
    const open = await this.db.unitFeeExemption.findFirst({ where: { unitId: unit.id, liftedAt: null }, select });
    if (unit.feeExemption !== null && open === null) {
      return this.db.unitFeeExemption.create({
        data: {
          unitId: unit.id,
          reason: unit.feeExemption as never,
          note: unit.feeExemptionNote?.trim() || null,
          validUntil: unit.feeExemptionValidUntil,
          grantedById: unit.feeExemptedById,
          grantedAt: unit.feeExemptedAt ?? at,
        },
        select,
      });
    }
    if (unit.feeExemption === null && open !== null) {
      await this.db.unitFeeExemption.update({
        where: { id: open.id },
        data: { liftedAt: at < open.grantedAt ? open.grantedAt : at, liftReason: RECONCILED_LIFT_REASON },
      });
      return null;
    }
    return open;
  }

  private async audit(
    action: string,
    buildingId: string,
    actor: { id: string; role: string },
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<BuildingChange & { tenantSlug: string }> {
    const payload: BuildingChange & { tenantSlug: string } = {
      tenantSlug: this.tenantContext.tenantSlug,
      action,
      buildingId,
      before,
      after,
      actorId: actor.id,
      actorRole: actor.role,
    };
    await this.auditTrail.recordChangeInTransaction({ channel: 'building.changed', payload });
    return payload;
  }

  // ─────────────────────────────  Reads  ─────────────────────────────

  /** One unit as the grant panel shows it: holders, the standing exemption, every period. */
  async unitView(unitId: string): Promise<FeeExemptionUnitView> {
    const row = (await this.db.unit.findUnique({ where: { id: unitId }, select: UNIT_VIEW_SELECT })) as UnitViewRow | null;
    if (!row) throw new NotFoundError({ code: 'UNIT_NOT_FOUND', message: 'This unit could not be found.' });
    return toUnitView(row, municipalToday());
  }

  /**
   * A unit by its full reference, «<building code>-<unit code>»
   * (`formatFullUnitReference`): a unit's own code is unique only inside its
   * building. Compared in upper case and Latin digits on both sides.
   */
  async unitByReference(reference: string): Promise<FeeExemptionUnitView> {
    const wanted = normalizeDigits(reference.trim()).toUpperCase();
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT u.id
        FROM ${this.S}units u
        JOIN ${this.S}buildings b ON b.id = u."buildingId"
       WHERE upper(b.code || '-' || u."unitCode") = ${wanted}
       LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundError({ code: 'UNIT_NOT_FOUND', message: 'No unit has this reference.' });
    }
    return this.unitView(rows[0]!.id);
  }

  /**
   * Every unit one person holds now — as owner, tenant or free occupant, on an
   * open spell — with each one's exemption, for granting or lifting them one at
   * a time. Structural floors are left out: nothing bills them. The person is
   * found only to reach the units; nothing here is keyed by them.
   */
  async citizenUnits(citizenId: string): Promise<FeeExemptionCitizenUnits> {
    const citizen = await this.db.user.findFirst({
      where: { id: citizenId, kind: 'CITIZEN' },
      select: { id: true, firstName: true, middleName: true, lastName: true, residence: true },
    });
    if (!citizen) throw new NotFoundError({ code: 'CITIZEN_NOT_FOUND', message: 'This citizen could not be found.' });

    const spells = await this.db.unitOccupancy.findMany({
      where: { citizenId, toDate: null },
      orderBy: [{ fromDate: 'asc' }],
      select: { role: true, unitId: true },
    });
    const roleOf = new Map<string, string>();
    for (const spell of spells) if (!roleOf.has(spell.unitId)) roleOf.set(spell.unitId, spell.role);

    const rows = (await this.db.unit.findMany({
      where: { id: { in: [...roleOf.keys()] } },
      orderBy: [{ building: { code: 'asc' } }, { floor: 'asc' }, { sequence: 'asc' }],
      select: UNIT_VIEW_SELECT,
    })) as UnitViewRow[];
    const today = municipalToday();
    return {
      citizen: { id: citizen.id, name: citizenDisplayName(citizen) },
      units: rows
        .filter((row) => !isStructuralUnitType(row.unitType))
        .map((row) => ({ ...toUnitView(row, today), role: roleOf.get(row.id) as OccupancyRole })),
      today,
    };
  }

  /**
   * «قائمة الإعفاء من الرسوم»: the exemption periods standing (`OPEN`) or lifted
   * (`LIFTED`), searched on the server. The search matches when the whole text,
   * in upper case and Latin digits, is part of the unit's code, its building's
   * code, the full reference «<building>-<unit>» or the parcel; or when every
   * folded word of it is part of the name of someone who holds the unit now
   * (`citizenSearchText`, the register's own search — without the رقم مرجعي for
   * a role shown it masked). A code is one word with its dashes, a name several,
   * so the two are matched apart. Newest first: granted for the standing list,
   * lifted for the lifted one.
   */
  async list(query: FeeExemptionListQuery, viewer: { role: string }): Promise<FeeExemptionListResult> {
    const today = municipalToday();
    const searchable = citizenSearchText(this.S, viewer.role, 'c');
    const text = normalizeDigits(query.q?.trim() ?? '').toUpperCase();
    const words = searchTokens(query.q);
    const code = likePattern(text);
    const byName = words.length
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM ${this.S}unit_occupancies o
            JOIN ${this.S}users c ON c.id = o."citizenId" AND c.kind = 'CITIZEN' AND c."isActive"
           WHERE o."unitId" = u.id AND o."toDate" IS NULL
             AND ${Prisma.join(
               words.map((word) => Prisma.sql`${searchable} LIKE ${likePattern(word)}`),
               ' AND ',
             )}
        )`
      : Prisma.sql`false`;
    const matches = text
      ? Prisma.sql`(
          upper(u."unitCode") LIKE ${code}
          OR upper(b.code) LIKE ${code}
          OR upper(b.code || '-' || u."unitCode") LIKE ${code}
          OR translate(b."parcelNumber", ${EASTERN_DIGITS}, ${LATIN_DIGITS}) LIKE ${code}
          OR ${byName}
        )`
      : Prisma.sql`true`;
    const status = query.status === 'LIFTED' ? Prisma.sql`e."liftedAt" IS NOT NULL` : Prisma.sql`e."liftedAt" IS NULL`;
    const reason = query.reason ? Prisma.sql`AND e.reason::text = ${query.reason}` : Prisma.empty;
    const order =
      query.status === 'LIFTED'
        ? Prisma.sql`e."liftedAt" DESC, e.id`
        : Prisma.sql`e."grantedAt" DESC, e.id`;
    const where = Prisma.sql`
        FROM ${this.S}unit_fee_exemptions e
        JOIN ${this.S}units u ON u.id = e."unitId"
        JOIN ${this.S}buildings b ON b.id = u."buildingId"
       WHERE ${status} ${reason} AND ${matches}`;

    const [{ total }] = await this.db.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS total ${where}`;
    const page = await this.db.$queryRaw<Array<{ periodId: string; unitId: string }>>`
      SELECT e.id AS "periodId", e."unitId" ${where}
       ORDER BY ${order}
       LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    `;

    const [periods, units] = await Promise.all([
      this.db.unitFeeExemption.findMany({ where: { id: { in: page.map((row) => row.periodId) } }, select: PERIOD_SELECT }),
      this.db.unit.findMany({
        where: { id: { in: [...new Set(page.map((row) => row.unitId))] } },
        select: {
          id: true,
          unitCode: true,
          unitType: true,
          feeExemptionValidUntil: true,
          building: { select: { id: true, code: true, name: true, parcelNumber: true } },
          occupancies: UNIT_VIEW_SELECT.occupancies,
        },
      }),
    ]);
    const periodById = new Map(periods.map((period) => [period.id, period as PeriodRow]));
    const unitById = new Map(units.map((unit) => [unit.id, unit]));

    const items: FeeExemptionListItem[] = page.map(({ periodId, unitId }) => {
      const unit = unitById.get(unitId)!;
      const period = periodById.get(periodId)!;
      return {
        ...unitRef(unit),
        period: toPeriodView(period),
        ended: period.liftedAt === null && period.validUntil !== null && calendarDayOf(period.validUntil) < today,
        holders: holdersOf(unit.occupancies),
      };
    });
    return { items, total, page: query.page, pageSize: query.pageSize, today };
  }
}

function staffRef(person: { id: string; firstName: string; lastName: string } | null) {
  return person ? { id: person.id, name: `${person.firstName} ${person.lastName}` } : null;
}

function toPeriodView(period: PeriodRow): FeeExemptionPeriodView {
  return {
    id: period.id,
    reason: period.reason as FeeExemptionReason,
    note: period.note,
    decisionRef: period.decisionRef,
    validUntil: period.validUntil ? calendarDayOf(period.validUntil) : null,
    grantedAt: period.grantedAt.toISOString(),
    grantedBy: staffRef(period.grantedBy),
    liftedAt: period.liftedAt?.toISOString() ?? null,
    liftedBy: staffRef(period.liftedBy),
    liftReason: period.liftReason,
  };
}

function holdersOf(occupancies: UnitViewRow['occupancies']): FeeExemptionHolder[] {
  const seen = new Set<string>();
  const holders: FeeExemptionHolder[] = [];
  for (const spell of occupancies) {
    if (seen.has(spell.citizen.id)) continue;
    seen.add(spell.citizen.id);
    holders.push({ citizenId: spell.citizen.id, name: citizenDisplayName(spell.citizen), role: spell.role as OccupancyRole });
  }
  return holders;
}

function unitRef(unit: Pick<UnitViewRow, 'id' | 'unitCode' | 'unitType' | 'building'>) {
  return {
    unitId: unit.id,
    unitCode: unit.unitCode,
    reference: formatFullUnitReference(unit.building.code, unit.unitCode),
    unitType: unit.unitType as UnitType | null,
    building: unit.building,
  };
}

function toUnitView(row: UnitViewRow, today: string): FeeExemptionUnitView {
  const history = row.feeExemptionPeriods.map(toPeriodView);
  return {
    ...unitRef(row),
    unitArea: row.unitArea == null ? null : Number(row.unitArea.toString()),
    holders: holdersOf(row.occupancies),
    current: history.find((period) => period.liftedAt === null) ?? null,
    exemptToday: isFeeExemptOn(row, today),
    history,
  };
}
