import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  cardsFiledOn,
  COMMISSION_RATE,
  creditBillableUnits,
  type CitizenMergeBillLine,
  type CitizenMergeCardLine,
  type CitizenMergeInput,
  type CitizenMergePayLine,
  type CitizenMergePreview,
  type CitizenMergeRecord,
  type CitizenMergeResult,
  type CitizenMergeSide,
  type CitizenUnmergePreview,
  type CitizenUnmergeBlockCode,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { readFootprint } from './landlord-link.service';
import {
  filedOn,
  flagWriteFor,
  planMerge,
  type FormOrder,
  type MergePlan,
  type PlanCard,
  type PlanInput,
  type PlanPerson,
} from './citizen-merge.plan';

/**
 * «دمج ملفين» and «التراجع عن الدمج» — see `citizen-merge.plan.ts` for every
 * decision, and `citizen-merge.schema.ts` (shared) for the contract.
 *
 * This file reads both files, asks the plan, and writes it: in one transaction,
 * with both citizens locked, after reading everything again under the lock and
 * refusing if either file moved since the preview the administrator agreed to.
 *
 * ## What the merge records, and why it can be undone
 *
 * Every row it re-points or ends is written into `citizen_merges.footprint`
 * with what it held before. The undo reverts exactly those rows — and only
 * while nothing has touched either file since, which is checked two ways: each
 * file's version stamp (every row of theirs that carries an `updatedAt`), and
 * each row the footprint names outside the two files (a tenant's card, a case,
 * a fee notice). An undo that reverted a file somebody had since edited would
 * throw that edit away without saying so.
 */

/** Stored in `citizen_merges.footprint`. Versioned because it outlives this code. */
interface MergeFootprint {
  v: 1;
  keepId: string;
  absorbId: string;
  /** When rows and spells were ended — the undo re-opens those carrying it. */
  at: string;
  newestRegistrationId: string | null;
  registrations: string[];
  cardMoves: Array<{ cardId: string; from: string; filedBefore: string | null }>;
  rowEnds: string[];
  cardEnds: string[];
  spellMoves: string[];
  spellEnds: string[];
  flagWrites: Array<{ registrationId: string; flaggedFields: unknown; status: string }>;
  payments: string[];
  checkouts: string[];
  cases: string[];
  feeNotices: string[];
  /** Other people's cards that named the absorbed person as their landlord. */
  tenantLinks: Array<{ cardId: string; footprintRewritten: boolean }>;
  /** Owner cards a link minted on the absorbed file, whose mint named them. */
  mints: string[];
  /**
   * Cards on which somebody had said «ليس هذا المالك» about the absorbed
   * person. The undo maps the kept person back to the absorbed one on these —
   * never overwrites the list, which may have gained answers since.
   * `hadKeep`: the kept person was already in the list, so the merge only
   * dropped the absorbed one.
   */
  dismissals: Array<{ cardId: string; hadKeep: boolean }>;
  /**
   * Open «مُعاد للتصحيح» returns carried onto the newest filing. The review
   * queue and the edit form close a return on the newest filing only, so one
   * left on a filing that stopped being the newest could never be answered.
   */
  reviewMoves?: Array<{ id: string; from: string }>;
  /** Columns filled on the kept file — names only; the undo restores a blank. */
  fills: string[];
  identityMoved: boolean;
  /** The kept file's own document type, which a moved document replaced. */
  identityTypeBefore?: string | null;
  /**
   * The newest filing's review settings before the kept person's stricter ones
   * were combined into it — see `apply`.
   */
  newestBefore?: { registrationId: string; citizenCanCorrect: boolean; revisitAt: string | null };
  /** Set by the undo: the flag reasons above were needed only to revert, and are gone. */
  redacted?: boolean;
  versionsAfter: { keep: string; absorb: string };
}

const PERSON_SELECT = {
  id: true,
  kind: true,
  isActive: true,
  referenceNumber: true,
  firstName: true,
  middleName: true,
  lastName: true,
  motherName: true,
  phone: true,
  whatsapp: true,
  gender: true,
  nationality: true,
  isLebanese: true,
  residencyNumber: true,
  residentStatus: true,
  identityDocType: true,
  identityDocNumber: true,
  civilRecordNumber: true,
  maritalStatus: true,
  bloodType: true,
  totalRegisteredMembers: true,
  actualHouseholdMembers: true,
  residence: true,
  residencePlace: true,
  localContactName: true,
  localContactPhone: true,
  createdAt: true,
  tokenVersion: true,
} as const;

/**
 * The person's columns a merge reads, fills or shows — compared by value in
 * `version`. Not `updatedAt`, `lastLoginAt` or `tokenVersion`: a login moves
 * those and changes nothing about who this is.
 */
const VERSIONED_PERSON = (() => {
  const { createdAt: _created, tokenVersion: _token, ...fields } = PERSON_SELECT;
  return fields;
})();

const fullName = (person: { firstName: string; middleName: string | null; lastName: string }) =>
  [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');

const RECORDED_IN_ERROR = 'RECORDED_IN_ERROR';

/** Everything the plan and the preview are made from. */
interface Loaded {
  keep: PlanPerson & { createdAt: Date; tokenVersion: number };
  absorb: PlanPerson & { createdAt: Date; tokenVersion: number };
  input: PlanInput;
  plan: MergePlan;
  payments: Array<{
    id: string;
    citizenId: string;
    feeNoticeId: string | null;
    periodKey: string;
    title: string;
    amount: Prisma.Decimal;
    currency: string;
    paymentStatus: string;
  }>;
  checkouts: Array<{ id: string; paymentId: string }>;
  cases: string[];
  feeNotices: string[];
  tenantLinks: Array<{ id: string; landlordLinkFootprint: Prisma.JsonValue }>;
  mints: Array<{ id: string; landlordLinkMint: Prisma.JsonValue }>;
  dismissals: Array<{ id: string; landlordLinkDismissedIds: string[] }>;
  unitCodes: Map<string, string>;
  /** The building each spell's unit stands in — for the census trail of a spell with no card. */
  unitBuilding: Map<string, string>;
  officers: Map<string, string>;
}

@Injectable()
export class CitizenMergeService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ─────────────────────────────  Preview  ─────────────────────────────

  /** What merging `absorbId` into `keepId` would do — read-only. */
  async preview(pair: { keepId: string; absorbId: string }): Promise<CitizenMergePreview> {
    const loaded = await this.load(pair.keepId, pair.absorbId);
    const versions = { keep: await this.version(pair.keepId), absorb: await this.version(pair.absorbId) };
    return this.describe(loaded, await this.payImpact(loaded), versions);
  }

  // ─────────────────────────────  Merge  ─────────────────────────────

  async merge(input: CitizenMergeInput & { tenantSlug: string; actor: { id: string; role: string } }): Promise<CitizenMergeResult> {
    const outcome = await runInTenantTransaction(this.tenantContext, async () => {
      /*
        Both people locked, in a fixed order so two merges of the same pair
        started from opposite ends wait for each other instead of deadlocking.
        Every edit of either file takes the same row lock through its update.
      */
      const ids = [input.keepId, input.absorbId].sort();
      await this.db.$queryRaw`
        SELECT id FROM ${this.S}users WHERE id IN (${ids[0]}::uuid, ${ids[1]}::uuid) ORDER BY id FOR UPDATE
      `;
      /*
        And the other people's cards this merge rewrites — tenants naming the
        absorbed person as landlord, «ليس هذا المالك» lists, owner cards a link
        minted. They are read below and written back from what was read; an
        «إلغاء الربط» committing in between would otherwise be undone by it.
      */
      await this.db.$queryRaw`
        SELECT id FROM ${this.S}property_entries
         WHERE "landlordCitizenId" IN (${ids[0]}::uuid, ${ids[1]}::uuid)
            OR ${input.absorbId}::uuid = ANY("landlordLinkDismissedIds")
            OR "landlordLinkMint"->>'ownerId' = ${input.absorbId}
         ORDER BY id FOR UPDATE
      `;

      const loaded = await this.load(input.keepId, input.absorbId);
      const [keepVersion, absorbVersion] = await Promise.all([
        this.version(input.keepId),
        this.version(input.absorbId),
      ]);
      if (keepVersion !== input.expected.keep || absorbVersion !== input.expected.absorb) {
        throw new ConflictError(
          'تغيّر أحد الملفين منذ فتحت المعاينة — راجع المعاينة الجديدة ثم أكّد الدمج.',
          { code: 'STALE_PREVIEW' },
        );
      }
      if (loaded.plan.blocks.length > 0) {
        throw new ConflictError(loaded.plan.blocks[0]!.message, { blocks: loaded.plan.blocks });
      }

      const preview = this.describe(loaded, await this.payImpact(loaded), {
        keep: keepVersion,
        absorb: absorbVersion,
      });
      const buildings = this.buildingsTouched(loaded);
      const footprint = await this.apply(loaded);
      await this.assertAbsorbedEmpty(loaded);
      footprint.versionsAfter = {
        keep: await this.version(input.keepId),
        absorb: await this.version(input.absorbId),
      };

      const record = await this.db.citizenMerge.create({
        data: {
          survivorId: input.keepId,
          absorbedId: input.absorbId,
          reason: input.reason,
          footprint: footprint as unknown as Prisma.InputJsonValue,
          mergedById: input.actor.id,
        },
        select: { id: true },
      });

      return { mergeId: record.id, preview, footprint, loaded, buildings };
    });

    this.announce({
      tenantSlug: input.tenantSlug,
      actor: input.actor,
      keepId: input.keepId,
      absorbId: input.absorbId,
      mergeId: outcome.mergeId,
      reason: input.reason,
      footprint: outcome.footprint,
      keepRef: outcome.loaded.keep.referenceNumber,
      absorbRef: outcome.loaded.absorb.referenceNumber,
      buildings: outcome.buildings,
      undo: false,
    });

    return {
      mergeId: outcome.mergeId,
      keepId: input.keepId,
      absorbId: input.absorbId,
      preview: outcome.preview,
    };
  }

  // ─────────────────────────────  Reading merges  ─────────────────────────────

  /** The merge this file was folded into, and the ones folded into it — for its page. */
  async mergesOf(citizenId: string): Promise<{ into: CitizenMergeRecord | null; from: CitizenMergeRecord[] }> {
    const rows = await this.db.citizenMerge.findMany({
      where: { OR: [{ survivorId: citizenId }, { absorbedId: citizenId }] },
      orderBy: { mergedAt: 'desc' },
      select: MERGE_RECORD_SELECT,
    });
    const records = rows.map(toRecord);
    return {
      into: records.find((record) => record.absorbed.id === citizenId && !record.undoneAt) ?? null,
      from: records.filter((record) => record.survivor.id === citizenId),
    };
  }

  /** Whether «التراجع عن الدمج» would go through, and if not, why. */
  async unmergePreview(mergeId: string): Promise<CitizenUnmergePreview> {
    const row = await this.db.citizenMerge.findUnique({ where: { id: mergeId }, select: MERGE_RECORD_SELECT });
    if (!row) throw new NotFoundError('الدمج غير موجود');
    return { merge: toRecord(row), blocks: await this.unmergeBlocks(mergeId) };
  }

  // ─────────────────────────────  Undo  ─────────────────────────────

  async unmerge(input: {
    mergeId: string;
    reason: string;
    tenantSlug: string;
    actor: { id: string; role: string };
  }): Promise<CitizenMergeRecord> {
    const outcome = await runInTenantTransaction(this.tenantContext, async () => {
      const merge = await this.db.citizenMerge.findUnique({
        where: { id: input.mergeId },
        select: { survivorId: true, absorbedId: true },
      });
      if (!merge) throw new NotFoundError('الدمج غير موجود');

      const ids = [merge.survivorId, merge.absorbedId].sort();
      await this.db.$queryRaw`
        SELECT id FROM ${this.S}users WHERE id IN (${ids[0]}::uuid, ${ids[1]}::uuid) ORDER BY id FOR UPDATE
      `;
      await this.db.$queryRaw`SELECT id FROM ${this.S}citizen_merges WHERE id = ${input.mergeId}::uuid FOR UPDATE`;
      const pending = await this.db.citizenMerge.findUniqueOrThrow({
        where: { id: input.mergeId },
        select: { footprint: true },
      });
      const outside = pending.footprint as unknown as Partial<MergeFootprint>;
      const outsideCards = [
        ...(outside.tenantLinks ?? []).map((link) => link.cardId),
        ...(outside.dismissals ?? []).map((card) => card.cardId),
        ...(outside.mints ?? []),
      ];
      if (outsideCards.length > 0) {
        await this.db.$queryRaw`
          SELECT id FROM ${this.S}property_entries WHERE id = ANY(${outsideCards}::uuid[]) ORDER BY id FOR UPDATE
        `;
      }

      const blocks = await this.unmergeBlocks(input.mergeId);
      if (blocks.length > 0) throw new ConflictError(blocks[0]!.message, { blocks });

      const stored = await this.db.citizenMerge.findUniqueOrThrow({
        where: { id: input.mergeId },
        select: { footprint: true },
      });
      const footprint = stored.footprint as unknown as MergeFootprint;
      await this.revert(footprint);

      /*
        The flag reasons were kept only so the undo could put them back. They
        can quote a document number or name another citizen, and once the
        undo has used them they are a second copy of that with no purpose.
      */
      const redacted: MergeFootprint = {
        ...footprint,
        flagWrites: footprint.flagWrites.map((write) => ({ ...write, flaggedFields: null })),
        redacted: true,
      };
      await this.db.citizenMerge.update({
        where: { id: input.mergeId },
        data: {
          undoneAt: new Date(),
          undoneById: input.actor.id,
          undoReason: input.reason,
          footprint: redacted as unknown as Prisma.InputJsonValue,
        },
      });

      const people = await this.db.user.findMany({
        where: { id: { in: [footprint.keepId, footprint.absorbId] } },
        select: { id: true, referenceNumber: true },
      });
      const refOf = (id: string) => people.find((person) => person.id === id)?.referenceNumber ?? null;
      const rows = await this.db.buildingUnit.findMany({
        where: { id: { in: footprint.rowEnds } },
        select: { propertyEntryId: true },
      });
      const touched = await this.db.propertyEntry.findMany({
        where: {
          id: {
            in: [
              ...footprint.cardEnds,
              ...footprint.cardMoves.map((move) => move.cardId),
              ...rows.map((row) => row.propertyEntryId),
            ],
          },
          buildingId: { not: null },
        },
        select: { buildingId: true },
      });
      const spellUnits = await this.db.unitOccupancy.findMany({
        where: { id: { in: footprint.spellMoves } },
        select: { unit: { select: { buildingId: true } } },
      });
      return {
        footprint,
        keepRef: refOf(footprint.keepId),
        absorbRef: refOf(footprint.absorbId),
        buildings: [
          ...new Set([
            ...touched.map((card) => card.buildingId!),
            ...spellUnits.map((spell) => spell.unit.buildingId),
          ]),
        ],
      };
    });

    this.announce({
      tenantSlug: input.tenantSlug,
      actor: input.actor,
      keepId: outcome.footprint.keepId,
      absorbId: outcome.footprint.absorbId,
      mergeId: input.mergeId,
      reason: input.reason,
      footprint: outcome.footprint,
      keepRef: outcome.keepRef,
      absorbRef: outcome.absorbRef,
      buildings: outcome.buildings,
      undo: true,
    });

    const row = await this.db.citizenMerge.findUniqueOrThrow({
      where: { id: input.mergeId },
      select: MERGE_RECORD_SELECT,
    });
    return toRecord(row);
  }

  // ─────────────────────────────  Loading  ─────────────────────────────

  private async load(keepId: string, absorbId: string): Promise<Loaded> {
    const [keep, absorb] = await Promise.all(
      [keepId, absorbId].map((id) =>
        this.db.user.findFirst({ where: { id, kind: 'CITIZEN' }, select: PERSON_SELECT }),
      ),
    );
    if (!keep) throw new NotFoundError('Citizen', keepId);
    if (!absorb) throw new NotFoundError('Citizen', absorbId);
    const people = [keepId, absorbId];

    const [liveMerges, registrations, spells] = await Promise.all([
      this.db.citizenMerge.findMany({
        where: { absorbedId: { in: people }, undoneAt: null },
        select: { absorbedId: true },
      }),
      this.db.registration.findMany({
        where: { citizenId: { in: people } },
        select: {
          id: true,
          citizenId: true,
          submittedAt: true,
          createdById: true,
          referenceNumber: true,
          status: true,
          flaggedFields: true,
        },
      }),
      this.db.unitOccupancy.findMany({
        where: { citizenId: { in: people } },
        select: { id: true, unitId: true, citizenId: true, role: true, toDate: true },
      }),
    ]);

    const cardRows = await this.db.propertyEntry.findMany({
      where: { registrationId: { in: registrations.map((registration) => registration.id) } },
      select: {
        id: true,
        registrationId: true,
        filedRegistrationId: true,
        createdAt: true,
        endedAt: true,
        occupancyType: true,
        propertyType: true,
        buildingId: true,
        propertyNumber: true,
        unitStatus: true,
        landlordCitizenId: true,
        landlordLinkMint: true,
        units: {
          select: {
            id: true,
            unitId: true,
            unitType: true,
            unitStatus: true,
            endedAt: true,
            endReason: true,
            createdAt: true,
          },
        },
      },
    });

    /*
      What tenants' links wrote into either file. Read off every card that names
      one of the two as landlord, through the same reader «إلغاء الربط» uses, so
      a footprint this build would not revert is not one it protects either.
    */
    const linkCards = await this.db.propertyEntry.findMany({
      where: { landlordCitizenId: { in: people } },
      select: { id: true, landlordCitizenId: true, landlordLinkFootprint: true },
    });
    const linkWritten = { cardIds: new Set<string>(), spellIds: new Set<string>() };
    for (const card of linkCards) {
      const footprint = readFootprint(card.landlordLinkFootprint, card.landlordCitizenId ?? '');
      if (!footprint) continue;
      footprint.mintedCardIds.forEach((id) => linkWritten.cardIds.add(id));
      for (const unit of footprint.units) {
        if (unit.occupancyId) linkWritten.spellIds.add(unit.occupancyId);
        if (unit.row) linkWritten.cardIds.add(unit.row.propertyEntryId);
      }
    }

    const unitIds = new Set<string>([
      ...spells.map((spell) => spell.unitId),
      ...cardRows.flatMap((card) => card.units.map((row) => row.unitId).filter((id): id is string => Boolean(id))),
    ]);
    const buildingIds = [
      ...new Set(cardRows.map((card) => card.buildingId).filter((id): id is string => Boolean(id))),
    ];
    const [units, buildingUnits, buildings] = await Promise.all([
      this.db.unit.findMany({
        where: { id: { in: [...unitIds] } },
        select: { id: true, unitCode: true, buildingId: true },
      }),
      this.db.unit.findMany({
        where: { buildingId: { in: buildingIds } },
        select: { id: true, buildingId: true, unitCode: true },
      }),
      this.db.building.findMany({ where: { id: { in: buildingIds } }, select: { id: true, code: true } }),
    ]);
    const unitCodes = new Map([...units, ...buildingUnits].map((unit) => [unit.id, unit.unitCode]));
    const unitBuilding = new Map(units.map((unit) => [unit.id, unit.buildingId]));
    const formOrder = new Map(
      await Promise.all(
        registrations.map(async (registration) => [registration.id, await this.formOrderOf(registration.id)] as const),
      ),
    );
    const perBuilding = new Map<string, string[]>();
    for (const unit of buildingUnits) {
      perBuilding.set(unit.buildingId, [...(perBuilding.get(unit.buildingId) ?? []), unit.id]);
    }
    const buildingCodes = new Map(buildings.map((building) => [building.id, building.code]));

    const cards: PlanCard[] = cardRows.map((card) => ({
      id: card.id,
      registrationId: card.registrationId,
      filedRegistrationId: card.filedRegistrationId,
      createdAt: card.createdAt,
      endedAt: card.endedAt,
      occupancyType: card.occupancyType,
      propertyType: card.propertyType,
      buildingId: card.buildingId,
      propertyNumber: card.propertyNumber,
      unitStatus: card.unitStatus,
      landlordCitizenId: card.landlordCitizenId,
      minted: card.landlordLinkMint !== null && card.landlordLinkMint !== undefined,
      units: card.units,
    }));

    const input: PlanInput = {
      keep: keep as unknown as PlanPerson,
      absorb: absorb as unknown as PlanPerson,
      keepMerged: liveMerges.some((merge) => merge.absorbedId === keepId),
      absorbMerged: liveMerges.some((merge) => merge.absorbedId === absorbId),
      registrations,
      cards,
      spells,
      formOrder,
      linkWritten,
      unitCode: (unitId) => unitCodes.get(unitId) ?? null,
      buildingCode: (buildingId) => buildingCodes.get(buildingId) ?? null,
      singleUnitOf: (buildingId) => {
        const list = perBuilding.get(buildingId) ?? [];
        return list.length === 1 ? list[0]! : null;
      },
    };

    const [payments, checkouts, cases, feeNotices, tenantLinks, dismissals] = await Promise.all([
      this.db.citizenPayment.findMany({
        where: { citizenId: { in: people } },
        select: {
          id: true,
          citizenId: true,
          feeNoticeId: true,
          periodKey: true,
          title: true,
          amount: true,
          currency: true,
          paymentStatus: true,
        },
      }),
      this.db.whishCheckout.findMany({ where: { citizenId: absorbId }, select: { id: true, paymentId: true } }),
      this.db.case.findMany({ where: { resolvedCitizenId: absorbId }, select: { id: true } }),
      this.db.feeNotice.findMany({ where: { targetCitizenId: absorbId }, select: { id: true } }),
      this.db.propertyEntry.findMany({
        where: { landlordCitizenId: absorbId },
        select: { id: true, landlordLinkFootprint: true },
      }),
      this.db.propertyEntry.findMany({
        where: { landlordLinkDismissedIds: { has: absorbId } },
        select: { id: true, landlordLinkDismissedIds: true },
      }),
    ]);
    const mints = cardRows
      .filter((card) => {
        const mint = card.landlordLinkMint as { ownerId?: string } | null;
        return mint && typeof mint === 'object' && mint.ownerId === absorbId;
      })
      .map((card) => ({ id: card.id, landlordLinkMint: card.landlordLinkMint }));

    const officerIds = [
      ...new Set(registrations.map((registration) => registration.createdById).filter((id): id is string => Boolean(id))),
    ];
    const officerRows = await this.db.user.findMany({
      where: { id: { in: officerIds }, kind: 'STAFF' },
      select: { id: true, firstName: true, lastName: true },
    });

    return {
      keep: keep as Loaded['keep'],
      absorb: absorb as Loaded['absorb'],
      input,
      plan: planMerge(input),
      payments,
      checkouts,
      cases: cases.map((row) => row.id),
      feeNotices: feeNotices.map((row) => row.id),
      tenantLinks,
      mints,
      dismissals,
      unitCodes,
      unitBuilding,
      officers: new Map(officerRows.map((row) => [row.id, `${row.firstName} ${row.lastName}`])),
    };
  }

  /**
   * One file's version: what the merge reads and would move, and nothing else.
   *
   * Wider than the edit form's `fileVersion`, which watches only the newest
   * filing's cards — a merge touches the person, every filing, every spell and
   * every bill, and a change to any of them is a change to what was previewed,
   * and a reason an undo would throw somebody's work away.
   *
   * Narrower than every `updatedAt` on those rows, deliberately. The person is
   * read by value, not by `users.updatedAt`: a portal login stamps that
   * (`markLoggedIn`), and a login is not a change to the file. Bills are read
   * by which bills exist, not when they were last touched: a collector marking
   * a payment seen, or the person paying it, leaves the bill theirs — the undo
   * moves it back with them — while a *new* bill issued against the merged
   * holdings is exactly what an undo must not carry off silently.
   */
  private async version(citizenId: string): Promise<string> {
    const [person, registrations, cards, rows, spells, bills] = await Promise.all([
      this.db.user.findUnique({ where: { id: citizenId }, select: VERSIONED_PERSON }),
      this.db.registration.findMany({ where: { citizenId }, orderBy: { id: 'asc' } }),
      this.db.propertyEntry.findMany({ where: { registration: { citizenId } }, orderBy: { id: 'asc' } }),
      this.db.buildingUnit.findMany({ where: { propertyEntry: { registration: { citizenId } } }, orderBy: { id: 'asc' } }),
      this.db.unitOccupancy.findMany({ where: { citizenId }, orderBy: { id: 'asc' } }),
      this.db.citizenPayment.findMany({ where: { citizenId }, select: { id: true }, orderBy: { id: 'asc' } }),
    ]);
    /*
      Rows by what they hold, not by when they were last written: an undo puts
      every column back exactly and moves `updatedAt` forward all the same, so a
      stamp of `updatedAt` would say «changed» about a file an undo had just
      restored — and a merge made before a later, undone one could never be
      undone in turn.
    */
    const content = <T extends { updatedAt?: unknown }>(list: readonly T[]) =>
      list.map(({ updatedAt: _written, ...row }) => row);
    return createHash('sha256')
      .update(
        JSON.stringify([
          person,
          content(registrations),
          content(cards),
          content(rows),
          content(spells),
          bills.map((bill) => bill.id),
        ]),
      )
      .digest('base64url')
      .slice(0, 32);
  }

  // ─────────────────────────────  Describing  ─────────────────────────────

  /**
   * What the merge does to officers' pay: the credit each loses for a copy
   * that ends «سُجِّل خطأً». Computed by the pay rule itself, over each
   * affected officer's whole history, because the credit is per distinct unit
   * — an officer who filed both copies loses nothing.
   */
  private async payImpact(loaded: Loaded): Promise<CitizenMergePayLine[]> {
    const endedRows = new Set(loaded.plan.rowEnds.map((end) => end.rowId));
    const endedCards = new Set(
      loaded.plan.cardEnds.filter((end) => end.reason === RECORDED_IN_ERROR).map((end) => end.cardId),
    );
    if (endedRows.size === 0 && endedCards.size === 0) return [];

    const registrationsById = new Map(loaded.input.registrations.map((registration) => [registration.id, registration]));
    const cardsById = new Map(loaded.input.cards.map((card) => [card.id, card]));
    const officers = new Set<string>();
    for (const cardId of [...loaded.plan.cardEnds.map((end) => end.cardId), ...loaded.plan.rowEnds.map((end) => end.cardId)]) {
      const card = cardsById.get(cardId);
      const officer = card ? registrationsById.get(filedOn(card))?.createdById : null;
      if (officer) officers.add(officer);
    }

    const lines: CitizenMergePayLine[] = [];
    for (const officerId of officers) {
      const registrations = await this.db.registration.findMany({
        where: { createdById: officerId },
        orderBy: { submittedAt: 'asc' },
        select: {
          id: true,
          properties: { select: EARNINGS_SELECT },
          movedCards: { select: EARNINGS_SELECT },
        },
      });
      const before = new Set<string>();
      const after = new Set<string>();
      let delta = 0;
      for (const registration of registrations) {
        const filed = cardsFiledOn(registration);
        delta -= creditBillableUnits(filed, before);
        delta += creditBillableUnits(
          filed.map((card) => ({
            ...card,
            endReason: endedCards.has(card.id) ? RECORDED_IN_ERROR : card.endReason,
            units: card.units.map((unit) => ({
              ...unit,
              endReason: endedRows.has(unit.id) ? RECORDED_IN_ERROR : unit.endReason,
            })),
          })),
          after,
        );
      }
      if (delta !== 0) {
        lines.push({
          officerId,
          officerName: loaded.officers.get(officerId) ?? 'موظف',
          delta: delta * COMMISSION_RATE,
        });
      }
    }
    return lines;
  }

  private describe(
    loaded: Loaded,
    pay: CitizenMergePayLine[],
    versions: { keep: string; absorb: string },
  ): CitizenMergePreview {
    const { plan, input, keep, absorb } = loaded;
    const side = (person: Loaded['keep'], version: string): CitizenMergeSide => {
      const regs = input.registrations.filter((registration) => registration.citizenId === person.id);
      const regIds = new Set(regs.map((registration) => registration.id));
      return {
        id: person.id,
        fullName: fullName(person),
        referenceNumber: person.referenceNumber,
        motherName: person.motherName,
        phone: person.phone,
        residence: person.residence,
        registeredAt: regs.length
          ? new Date(Math.min(...regs.map((registration) => registration.submittedAt.getTime()))).toISOString()
          : null,
        registrations: regs.length,
        currentCards: input.cards.filter((card) => regIds.has(card.registrationId) && !card.endedAt).length,
        version,
      };
    };
    const absorbRegs = new Set(plan.registrationMoves);
    const fromOf = (registrationId: string): 'keep' | 'absorb' => (absorbRegs.has(registrationId) ? 'absorb' : 'keep');
    const cardsById = new Map(input.cards.map((card) => [card.id, card]));
    const registrationsById = new Map(input.registrations.map((registration) => [registration.id, registration]));

    const cardsMoved: CitizenMergeCardLine[] = plan.cardMoves.map((move) => {
      const card = cardsById.get(move.cardId)!;
      return {
        cardId: card.id,
        from: fromOf(move.fromRegistrationId),
        label: [PROPERTY_TYPE_LABEL[card.propertyType] ?? card.propertyType, card.propertyNumber]
          .filter(Boolean)
          .join(' '),
        unitCodes: card.units
          .filter((row) => !row.endedAt && row.unitId)
          .map((row) => loaded.unitCodes.get(row.unitId!) ?? '')
          .filter(Boolean),
        unlinked: !card.buildingId,
      };
    });

    const collisions = collidingBills(loaded.payments, keep.id, absorb.id);

    return {
      keep: side(keep, versions.keep),
      absorb: side(absorb, versions.absorb),
      blocks: plan.blocks,
      fills: plan.fillsForDisplay,
      conflicts: plan.conflicts,
      newestFiling: plan.newest
        ? {
            id: plan.newest.id,
            referenceNumber: plan.newest.referenceNumber,
            from: fromOf(plan.newest.id),
          }
        : { id: '', referenceNumber: '', from: 'keep' },
      cardsMoved,
      duplicates: plan.duplicates.map((duplicate) => ({
        label: duplicate.label,
        unitCode: duplicate.unitId ? (loaded.unitCodes.get(duplicate.unitId) ?? null) : null,
        filedBy: loaded.officers.get(registrationsById.get(duplicate.filedOnRegistrationId)?.createdById ?? '') ?? null,
      })),
      pay,
      counts: {
        registrations: plan.registrationMoves.length,
        spellsMoved: plan.spellMoves.length,
        spellsEnded: plan.spellEnds.length,
        bills: loaded.payments.filter((payment) => payment.citizenId === absorb.id && !collisions.has(payment.id)).length,
        checkouts: loaded.checkouts.filter((checkout) => !collisions.has(checkout.paymentId)).length,
        cases: loaded.cases.length,
        feeNotices: loaded.feeNotices.length,
        tenantLinks: loaded.tenantLinks.length,
        flagsAnswered: plan.flagsAnswered,
      },
      billsLeftBehind: loaded.payments
        .filter((payment) => collisions.has(payment.id))
        .map(
          (payment): CitizenMergeBillLine => ({
            paymentId: payment.id,
            title: payment.title,
            periodKey: payment.periodKey,
            amount: Number(payment.amount),
            currency: payment.currency,
            paymentStatus: payment.paymentStatus,
          }),
        ),
    };
  }

  // ─────────────────────────────  Writing  ─────────────────────────────

  private async apply(loaded: Loaded): Promise<MergeFootprint> {
    const { plan, keep, absorb } = loaded;
    const at = new Date();
    const db = this.db;

    // Filings first: every later write is about rows that now belong to the kept person.
    if (plan.registrationMoves.length > 0) {
      await db.registration.updateMany({
        where: { id: { in: plan.registrationMoves } },
        data: { citizenId: keep.id },
      });
    }

    for (const move of plan.cardMoves) {
      await db.propertyEntry.update({
        where: { id: move.cardId },
        data: { registrationId: move.toRegistrationId, filedRegistrationId: move.filedRegistrationIdAfter },
      });
    }
    if (plan.rowEnds.length > 0) {
      await db.buildingUnit.updateMany({
        where: { id: { in: plan.rowEnds.map((end) => end.rowId) } },
        data: { endedAt: at, endReason: RECORDED_IN_ERROR },
      });
    }
    for (const reason of [RECORDED_IN_ERROR, null] as const) {
      const ids = plan.cardEnds.filter((end) => end.reason === reason).map((end) => end.cardId);
      if (ids.length > 0) {
        await db.propertyEntry.updateMany({ where: { id: { in: ids } }, data: { endedAt: at, endReason: reason } });
      }
    }

    /*
      Spells: the duplicates end before anything is re-pointed, because the
      kept person may hold only one current spell per unit
      (`unit_occupancies_unitId_citizenId_current_key`).
    */
    if (plan.spellEnds.length > 0) {
      await db.unitOccupancy.updateMany({
        where: { id: { in: plan.spellEnds } },
        data: { toDate: at, endReason: RECORDED_IN_ERROR },
      });
    }
    if (plan.spellMoves.length > 0) {
      await db.unitOccupancy.updateMany({
        where: { id: { in: plan.spellMoves } },
        data: { citizenId: keep.id },
      });
    }

    /*
      Flags, placed against the order the form's own query returns now that the
      cards have moved — not the order predicted before they did. Cards filed
      in one save tie on `createdAt`, and the order among them after an update
      is whatever the database returns; only reading it tells.
    */
    const flagWrites: MergeFootprint['flagWrites'] = [];
    for (const registration of loaded.input.registrations) {
      const after = plan.flagsFor(registration.id, await this.formOrderOf(registration.id));
      const write = after ? flagWriteFor(registration, after) : null;
      if (!write) continue;
      await db.registration.update({
        where: { id: registration.id },
        data: { flaggedFields: write.after.flaggedFields as never, status: write.after.status as never },
      });
      flagWrites.push({
        registrationId: registration.id,
        flaggedFields: write.before.flaggedFields,
        status: write.before.status,
      });
    }

    /*
      The kept person's flags now live on another filing, and so must their
      review settings: a filing the citizen may correct online, or that is due a
      visit, stays so. The stricter of the two, never the looser.
    */
    let newestBefore: MergeFootprint['newestBefore'];
    if (plan.newest && plan.keepNewest && plan.newest.id !== plan.keepNewest.id) {
      const [newestRow, keepRow] = await Promise.all([
        db.registration.findUniqueOrThrow({
          where: { id: plan.newest.id },
          select: { citizenCanCorrect: true, revisitAt: true },
        }),
        db.registration.findUniqueOrThrow({
          where: { id: plan.keepNewest.id },
          select: { citizenCanCorrect: true, revisitAt: true },
        }),
      ]);
      const visits = [newestRow.revisitAt, keepRow.revisitAt].filter((when): when is Date => Boolean(when));
      const revisitAt = visits.length ? new Date(Math.min(...visits.map((when) => when.getTime()))) : null;
      const citizenCanCorrect = newestRow.citizenCanCorrect && keepRow.citizenCanCorrect;
      if (citizenCanCorrect !== newestRow.citizenCanCorrect || revisitAt?.getTime() !== newestRow.revisitAt?.getTime()) {
        await db.registration.update({ where: { id: plan.newest.id }, data: { citizenCanCorrect, revisitAt } });
        newestBefore = {
          registrationId: plan.newest.id,
          citizenCanCorrect: newestRow.citizenCanCorrect,
          revisitAt: newestRow.revisitAt?.toISOString() ?? null,
        };
      }
    }

    const reviewMoves: NonNullable<MergeFootprint['reviewMoves']> = [];
    const formerNewest = [plan.keepNewest?.id, plan.absorbNewest?.id].filter(
      (id): id is string => Boolean(id) && id !== plan.newest?.id,
    );
    if (plan.newest && formerNewest.length > 0) {
      const open = await db.recordReview.findMany({
        where: { registrationId: { in: formerNewest }, outcome: 'RETURNED', resolvedAt: null },
        select: { id: true, registrationId: true },
      });
      for (const review of open) {
        await db.recordReview.update({ where: { id: review.id }, data: { registrationId: plan.newest.id } });
        reviewMoves.push({ id: review.id, from: review.registrationId });
      }
    }

    /*
      Bills follow the person — except one both files carry for the same
      notice and period, which cannot (one bill per person per notice per
      period) and is not this action's to cancel. It stays on the absorbed
      file, untouched, and the preview named it for the accountant.
    */
    const collisions = collidingBills(loaded.payments, keep.id, absorb.id);
    const payments = loaded.payments
      .filter((payment) => payment.citizenId === absorb.id && !collisions.has(payment.id))
      .map((payment) => payment.id);
    if (payments.length > 0) {
      await db.citizenPayment.updateMany({ where: { id: { in: payments } }, data: { citizenId: keep.id } });
    }
    const checkouts = loaded.checkouts
      .filter((checkout) => !collisions.has(checkout.paymentId))
      .map((checkout) => checkout.id);
    if (checkouts.length > 0) {
      await db.whishCheckout.updateMany({ where: { id: { in: checkouts } }, data: { citizenId: keep.id } });
    }
    if (loaded.cases.length > 0) {
      await db.case.updateMany({ where: { id: { in: loaded.cases } }, data: { resolvedCitizenId: keep.id } });
    }
    if (loaded.feeNotices.length > 0) {
      await db.feeNotice.updateMany({ where: { id: { in: loaded.feeNotices } }, data: { targetCitizenId: keep.id } });
    }

    /*
      Tenants who named the absorbed person as their landlord now name the kept
      one — and so does the footprint each link keeps, or «إلغاء الربط» would
      stop recognising its own work (`readFootprint` checks the owner).
    */
    const tenantLinks: MergeFootprint['tenantLinks'] = [];
    for (const card of loaded.tenantLinks) {
      const footprint = readFootprint(card.landlordLinkFootprint, absorb.id);
      await db.propertyEntry.update({
        where: { id: card.id },
        data: {
          landlordCitizenId: keep.id,
          ...(footprint
            ? { landlordLinkFootprint: { ...(card.landlordLinkFootprint as object), ownerId: keep.id } as never }
            : {}),
        },
      });
      tenantLinks.push({ cardId: card.id, footprintRewritten: Boolean(footprint) });
    }
    for (const card of loaded.mints) {
      await db.propertyEntry.update({
        where: { id: card.id },
        data: { landlordLinkMint: { ...(card.landlordLinkMint as object), ownerId: keep.id } as never },
      });
    }
    const dismissals: MergeFootprint['dismissals'] = [];
    for (const card of loaded.dismissals) {
      const next = [...new Set(card.landlordLinkDismissedIds.map((id) => (id === absorb.id ? keep.id : id)))];
      await db.propertyEntry.update({ where: { id: card.id }, data: { landlordLinkDismissedIds: next } });
      dismissals.push({ cardId: card.id, hadKeep: card.landlordLinkDismissedIds.includes(keep.id) });
    }

    /*
      The person. The identity document is unique across the register, so it
      leaves the absorbed row before it arrives on the kept one.
    */
    if (plan.identityMoves) {
      await db.user.update({
        where: { id: absorb.id },
        data: { identityDocType: null, identityDocNumber: null },
      });
    }
    if (plan.fills.length > 0) {
      await db.user.update({
        where: { id: keep.id },
        data: Object.fromEntries(plan.fills.map((fill) => [fill.field, fill.value])) as Prisma.UserUpdateInput,
      });
    }
    await db.user.update({
      where: { id: absorb.id },
      // Deactivated, and any session they hold on the citizen portal ends.
      data: { isActive: false, tokenVersion: { increment: 1 } },
    });

    return {
      v: 1,
      keepId: keep.id,
      absorbId: absorb.id,
      at: at.toISOString(),
      newestRegistrationId: plan.newest?.id ?? null,
      registrations: plan.registrationMoves,
      cardMoves: plan.cardMoves.map((move) => ({
        cardId: move.cardId,
        from: move.fromRegistrationId,
        filedBefore: move.filedRegistrationIdBefore,
      })),
      rowEnds: plan.rowEnds.map((end) => end.rowId),
      cardEnds: plan.cardEnds.map((end) => end.cardId),
      spellMoves: plan.spellMoves,
      spellEnds: plan.spellEnds,
      flagWrites,
      payments,
      checkouts,
      cases: loaded.cases,
      feeNotices: loaded.feeNotices,
      tenantLinks,
      mints: loaded.mints.map((card) => card.id),
      dismissals,
      reviewMoves,
      fills: plan.fills.map((fill) => fill.field),
      identityMoved: plan.identityMoves,
      identityTypeBefore: plan.identityMoves ? keep.identityDocType : undefined,
      newestBefore,
      versionsAfter: { keep: '', absorb: '' },
    };
  }

  /** Why an undo cannot go through — empty when it can. */
  private async unmergeBlocks(mergeId: string): Promise<Array<{ code: CitizenUnmergeBlockCode; message: string }>> {
    const merge = await this.db.citizenMerge.findUnique({
      where: { id: mergeId },
      select: { survivorId: true, absorbedId: true, undoneAt: true, footprint: true },
    });
    if (!merge) throw new NotFoundError('الدمج غير موجود');
    if (merge.undoneAt) return [{ code: 'ALREADY_UNDONE', message: 'تمّ التراجع عن هذا الدمج مسبقاً.' }];

    const later = await this.db.citizenMerge.findFirst({
      where: { absorbedId: merge.survivorId, undoneAt: null },
      select: { survivor: { select: { firstName: true, lastName: true, referenceNumber: true } } },
    });
    if (later) {
      return [
        {
          code: 'MERGED_AGAIN',
          message: `الملف الباقي نفسه دُمج بعدها في ملف ${later.survivor.firstName} ${later.survivor.lastName}${
            later.survivor.referenceNumber ? ` (${later.survivor.referenceNumber})` : ''
          }. تراجع عن ذلك الدمج أولاً.`,
        },
      ];
    }

    const footprint = merge.footprint as unknown as MergeFootprint;
    if (footprint?.v !== 1) {
      return [{ code: 'CHANGED_SINCE', message: 'سجل هذا الدمج بصيغة لا يعرفها هذا الإصدار — لا يمكن التراجع عنه آلياً.' }];
    }

    const [keep, absorb] = await Promise.all([this.version(footprint.keepId), this.version(footprint.absorbId)]);
    const outside = await this.outsideRowsMoved(footprint);
    if (keep !== footprint.versionsAfter.keep || absorb !== footprint.versionsAfter.absorb || outside) {
      return [
        {
          code: 'CHANGED_SINCE',
          message:
            'عُدِّل أحد الملفين (أو ما نقله الدمج) منذ الدمج، فالتراجع الآلي قد يمحو ذلك التعديل. صحّح الملف يدوياً، أو اطلب تصحيحاً من إدارة النظام.',
        },
      ];
    }
    return [];
  }

  /** Whether a row the merge re-pointed outside the two files has moved since. */
  private async outsideRowsMoved(footprint: MergeFootprint): Promise<boolean> {
    const [links, cases, notices] = await Promise.all([
      this.db.propertyEntry.count({
        where: { id: { in: footprint.tenantLinks.map((link) => link.cardId) }, landlordCitizenId: footprint.keepId },
      }),
      this.db.case.count({ where: { id: { in: footprint.cases }, resolvedCitizenId: footprint.keepId } }),
      this.db.feeNotice.count({ where: { id: { in: footprint.feeNotices }, targetCitizenId: footprint.keepId } }),
    ]);
    return (
      links !== footprint.tenantLinks.length ||
      cases !== footprint.cases.length ||
      notices !== footprint.feeNotices.length
    );
  }

  /** The merge, backwards. Every write names the rows the footprint recorded. */
  private async revert(footprint: MergeFootprint): Promise<void> {
    const db = this.db;
    const { keepId, absorbId } = footprint;

    await db.user.update({ where: { id: absorbId }, data: { isActive: true } });

    const fills = footprint.fills.filter((field) => field !== 'identityDocType' && field !== 'identityDocNumber');
    if (fills.length > 0) {
      await db.user.update({
        where: { id: keepId },
        data: Object.fromEntries(fills.map((field) => [field, null])) as Prisma.UserUpdateInput,
      });
    }
    if (footprint.identityMoved) {
      const kept = await db.user.findUniqueOrThrow({
        where: { id: keepId },
        select: { identityDocType: true, identityDocNumber: true },
      });
      await db.user.update({
        where: { id: keepId },
        data: { identityDocType: (footprint.identityTypeBefore ?? null) as never, identityDocNumber: null },
      });
      await db.user.update({
        where: { id: absorbId },
        data: { identityDocType: kept.identityDocType, identityDocNumber: kept.identityDocNumber },
      });
    }

    for (const card of footprint.dismissals) {
      const row = await db.propertyEntry.findUniqueOrThrow({
        where: { id: card.cardId },
        select: { landlordLinkDismissedIds: true },
      });
      // Only what the merge changed is changed back; answers given since stay.
      const ids = row.landlordLinkDismissedIds;
      const next = card.hadKeep
        ? [...new Set([...ids, absorbId])]
        : [...new Set(ids.map((id) => (id === keepId ? absorbId : id)))];
      await db.propertyEntry.update({ where: { id: card.cardId }, data: { landlordLinkDismissedIds: next } });
    }
    for (const cardId of footprint.mints) {
      const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: cardId }, select: { landlordLinkMint: true } });
      await db.propertyEntry.update({
        where: { id: cardId },
        data: { landlordLinkMint: { ...(card.landlordLinkMint as object), ownerId: absorbId } as never },
      });
    }
    for (const link of footprint.tenantLinks) {
      const card = await db.propertyEntry.findUniqueOrThrow({
        where: { id: link.cardId },
        select: { landlordLinkFootprint: true },
      });
      await db.propertyEntry.update({
        where: { id: link.cardId },
        data: {
          landlordCitizenId: absorbId,
          ...(link.footprintRewritten
            ? { landlordLinkFootprint: { ...(card.landlordLinkFootprint as object), ownerId: absorbId } as never }
            : {}),
        },
      });
    }

    if (footprint.feeNotices.length > 0) {
      await db.feeNotice.updateMany({ where: { id: { in: footprint.feeNotices } }, data: { targetCitizenId: absorbId } });
    }
    if (footprint.cases.length > 0) {
      await db.case.updateMany({ where: { id: { in: footprint.cases } }, data: { resolvedCitizenId: absorbId } });
    }
    if (footprint.checkouts.length > 0) {
      await db.whishCheckout.updateMany({ where: { id: { in: footprint.checkouts } }, data: { citizenId: absorbId } });
    }
    if (footprint.payments.length > 0) {
      await db.citizenPayment.updateMany({ where: { id: { in: footprint.payments } }, data: { citizenId: absorbId } });
    }

    for (const write of footprint.flagWrites) {
      await db.registration.update({
        where: { id: write.registrationId },
        data: { flaggedFields: write.flaggedFields as never, status: write.status as never },
      });
    }
    for (const review of footprint.reviewMoves ?? []) {
      await db.recordReview.update({ where: { id: review.id }, data: { registrationId: review.from } });
    }
    if (footprint.newestBefore) {
      await db.registration.update({
        where: { id: footprint.newestBefore.registrationId },
        data: {
          citizenCanCorrect: footprint.newestBefore.citizenCanCorrect,
          revisitAt: footprint.newestBefore.revisitAt ? new Date(footprint.newestBefore.revisitAt) : null,
        },
      });
    }

    // Re-pointed back before re-opened: the absorbed person's reopened spell sits beside the kept one's.
    if (footprint.spellMoves.length > 0) {
      await db.unitOccupancy.updateMany({ where: { id: { in: footprint.spellMoves } }, data: { citizenId: absorbId } });
    }
    if (footprint.spellEnds.length > 0) {
      await db.unitOccupancy.updateMany({
        where: { id: { in: footprint.spellEnds } },
        data: { toDate: null, endReason: null },
      });
    }
    if (footprint.cardEnds.length > 0) {
      await db.propertyEntry.updateMany({
        where: { id: { in: footprint.cardEnds } },
        data: { endedAt: null, endReason: null },
      });
    }
    if (footprint.rowEnds.length > 0) {
      await db.buildingUnit.updateMany({
        where: { id: { in: footprint.rowEnds } },
        data: { endedAt: null, endReason: null },
      });
    }
    for (const move of footprint.cardMoves) {
      await db.propertyEntry.update({
        where: { id: move.cardId },
        data: { registrationId: move.from, filedRegistrationId: move.filedBefore },
      });
    }
    if (footprint.registrations.length > 0) {
      await db.registration.updateMany({
        where: { id: { in: footprint.registrations } },
        data: { citizenId: absorbId },
      });
    }
  }

  // ─────────────────────────────  Telling everyone  ─────────────────────────────

  /**
   * One `citizen.changed` per file — which writes each file's audit row and
   * clears the profile, quality and review-queue caches — and one
   * `building.changed` for the census screens, whose occupants just moved.
   *
   * The audit rows carry counts, field *names* and ids, never a field's value:
   * a filled civil record number is written as the word, as `fileChanges` does.
   */
  private announce(input: {
    tenantSlug: string;
    actor: { id: string; role: string };
    keepId: string;
    absorbId: string;
    mergeId: string;
    reason: string;
    footprint: MergeFootprint;
    keepRef: string | null;
    absorbRef: string | null;
    /** Buildings whose cards the merge ended or moved — each gets a line in its own trail. */
    buildings: readonly string[];
    undo: boolean;
  }): void {
    const { footprint } = input;
    const summary = {
      mergeId: input.mergeId,
      reason: input.reason,
      registrations: footprint.registrations.length,
      cardsMoved: footprint.cardMoves.length,
      recordedInError: { rows: footprint.rowEnds.length, cards: footprint.cardEnds.length, spells: footprint.spellEnds.length },
      spellsMoved: footprint.spellMoves.length,
      bills: footprint.payments.length,
      tenantLinks: footprint.tenantLinks.length,
      filled: footprint.fills,
    };
    this.events.emit('citizen.changed', {
      tenantSlug: input.tenantSlug,
      citizenId: input.keepId,
      action: input.undo ? 'CITIZEN_MERGE_UNDONE' : 'CITIZEN_MERGED',
      after: { ...summary, other: { id: input.absorbId, referenceNumber: input.absorbRef } },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
    this.events.emit('citizen.changed', {
      tenantSlug: input.tenantSlug,
      citizenId: input.absorbId,
      action: input.undo ? 'CITIZEN_MERGE_UNDONE' : 'CITIZEN_MERGED_INTO',
      after: { ...summary, other: { id: input.keepId, referenceNumber: input.keepRef } },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
    for (const buildingId of input.buildings) {
      this.events.emit('building.changed', {
        tenantSlug: input.tenantSlug,
        buildingId,
        action: input.undo ? 'CITIZEN_MERGE_UNDONE' : 'CITIZEN_MERGED',
        after: { mergeId: input.mergeId, keptId: input.keepId, absorbedId: input.absorbId },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }
  }

  /** The buildings a merge's ended and moved cards sit on. */
  private buildingsTouched(loaded: Loaded): string[] {
    const cards = new Map(loaded.input.cards.map((card) => [card.id, card]));
    const spellBuildings = loaded.plan.spellMoves
      .map((spellId) => loaded.input.spells.find((spell) => spell.id === spellId)?.unitId)
      .map((unitId) => (unitId ? loaded.unitBuilding.get(unitId) : undefined))
      .filter((id): id is string => Boolean(id));
    const ids = [
      ...loaded.plan.cardEnds.map((end) => end.cardId),
      ...loaded.plan.rowEnds.map((end) => end.cardId),
      ...loaded.plan.cardMoves.map((move) => move.cardId),
    ];
    return [
      ...new Set([
        ...ids.map((id) => cards.get(id)?.buildingId).filter((id): id is string => Boolean(id)),
        ...spellBuildings,
      ]),
    ];
  }

  /**
   * A filing's current cards and rows in the order the edit form lists them —
   * the form's own query (`CitizensService.getEditable`), nested the same way,
   * because that order is what a flag's position means. See `FormOrder`.
   */
  private async formOrderOf(registrationId: string): Promise<FormOrder> {
    const registration = await this.db.registration.findUnique({
      where: { id: registrationId },
      select: {
        properties: {
          where: { endedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, units: { where: { endedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } } },
        },
      },
    });
    return (registration?.properties ?? []).map((card) => ({ id: card.id, rows: card.units.map((row) => row.id) }));
  }

  /**
   * After the writes, before the commit: the absorbed file holds nothing the
   * merge should have moved. A filing, spell, case, notice or tenant's link
   * that landed on it while the merge ran — from a path that never touches the
   * person's row, like the matrix or a billing run — would otherwise be left
   * on a file nobody sees. The merge is refused and rolled back instead.
   */
  private async assertAbsorbedEmpty(loaded: Loaded): Promise<void> {
    const absorbId = loaded.absorb.id;
    const leftBehind = new Set(
      [...collidingBills(loaded.payments, loaded.keep.id, absorbId)],
    );
    const [registrations, spells, cases, notices, links, bills] = await Promise.all([
      this.db.registration.count({ where: { citizenId: absorbId } }),
      this.db.unitOccupancy.count({ where: { citizenId: absorbId } }),
      this.db.case.count({ where: { resolvedCitizenId: absorbId } }),
      this.db.feeNotice.count({ where: { targetCitizenId: absorbId } }),
      this.db.propertyEntry.count({ where: { landlordCitizenId: absorbId } }),
      this.db.citizenPayment.findMany({ where: { citizenId: absorbId }, select: { id: true } }),
    ]);
    const strayBills = bills.filter((bill) => !leftBehind.has(bill.id)).length;
    if (registrations + spells + cases + notices + links + strayBills > 0) {
      throw new ConflictError('تغيّر الملف المدموج أثناء الدمج (سُجِّل عليه شيء جديد). أعد فتح المعاينة وحاول مجدداً.', {
        code: 'STALE_PREVIEW',
      });
    }
  }
}

// ─────────────────────────────  Helpers  ─────────────────────────────

const EARNINGS_SELECT = {
  id: true,
  endReason: true,
  filedRegistrationId: true,
  units: { select: { id: true, unitId: true, unitType: true, endReason: true } },
} as const;

const PROPERTY_TYPE_LABEL: Record<string, string> = {
  BUILDING: 'مبنى',
  HOUSE: 'منزل',
  LAND: 'أرض',
  TENT: 'خيمة',
};

/**
 * The absorbed file's bills that the kept file already carries for the same
 * notice and period — one bill per person per notice per period
 * (`citizen_payments_citizenId_feeNoticeId_periodKey_key`).
 */
function collidingBills(
  payments: Loaded['payments'],
  keepId: string,
  absorbId: string,
): Set<string> {
  // A bill raised against no notice is unique by nothing: Postgres treats the NULLs as distinct.
  const key = (payment: Loaded['payments'][number]) =>
    payment.feeNoticeId ? `${payment.feeNoticeId}|${payment.periodKey}` : null;
  const held = new Set(
    payments
      .filter((payment) => payment.citizenId === keepId)
      .map(key)
      .filter((value): value is string => Boolean(value)),
  );
  return new Set(
    payments
      .filter((payment) => payment.citizenId === absorbId && held.has(key(payment) ?? ''))
      .map((payment) => payment.id),
  );
}

const MERGE_RECORD_SELECT = {
  id: true,
  reason: true,
  mergedAt: true,
  undoneAt: true,
  undoReason: true,
  survivor: { select: { id: true, firstName: true, middleName: true, lastName: true, referenceNumber: true } },
  absorbed: { select: { id: true, firstName: true, middleName: true, lastName: true, referenceNumber: true } },
  mergedBy: { select: { firstName: true, lastName: true } },
  undoneBy: { select: { firstName: true, lastName: true } },
} as const;

type MergeRecordRow = Prisma.CitizenMergeGetPayload<{ select: typeof MERGE_RECORD_SELECT }>;

function toRecord(row: MergeRecordRow): CitizenMergeRecord {
  const person = (p: MergeRecordRow['survivor']) => ({
    id: p.id,
    fullName: fullName(p),
    referenceNumber: p.referenceNumber,
  });
  return {
    id: row.id,
    survivor: person(row.survivor),
    absorbed: person(row.absorbed),
    reason: row.reason,
    mergedAt: row.mergedAt.toISOString(),
    mergedBy: row.mergedBy ? `${row.mergedBy.firstName} ${row.mergedBy.lastName}` : null,
    undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
    undoneBy: row.undoneBy ? `${row.undoneBy.firstName} ${row.undoneBy.lastName}` : null,
    undoReason: row.undoReason,
  };
}

