import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  POSSIBLE_DUPLICATE_FLAG_PATH,
  type DismissFindingInput,
  type FieldFlag,
  type QualityFindingKind,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { metresBetween } from '../buildings/buildings.service';
import { LandlordLinkService } from '../citizens/landlord-link.service';
import { duplicateSignals, foldNamePart, isLikelySamePerson, matchedOn } from '../citizens/possible-duplicates';

/**
 * Two buildings on one parcel closer than this are shown as a possible single
 * structure. Parcel 56's duplicates stood 3.6–5.9 m apart; genuine neighbours
 * here stand 2–7 m apart too (parcel 45), which is why this is a finding to look
 * at and dismiss with a reason, never a rule.
 */
const NEAR_BUILDING_METRES = 10;

/** A name block larger than this is compared only on its phones — see `duplicateCitizens`. */
const MAX_BLOCK = 2000;

export type FindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface FindingSubject {
  kind: 'citizen' | 'building';
  id: string;
  label: string;
  secondary: string | null;
}

export interface QualityFinding {
  kind: QualityFindingKind;
  /** Stable across recomputation — what a dismissal is stored against. */
  subjectKey: string;
  severity: FindingSeverity;
  /** One sentence of evidence, in the register's language. */
  detail: string;
  subjects: FindingSubject[];
  /** The officers whose filings the finding is about. */
  officers: Array<{ id: string; name: string }>;
  /** When the newest record involved was filed or created. */
  at: string | null;
  /** Some findings are closed by fixing the record, not by saying «ليست مشكلة». */
  dismissable: boolean;
  dismissal: { reason: string; by: string | null; at: string } | null;
}

const fullName = (row: { firstName: string; middleName?: string | null; lastName: string }) =>
  [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ');

const SEVERITY_ORDER: Record<FindingSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * «ملاحظات الجودة» — what the register itself can tell is probably wrong.
 *
 * Each kind is one of the checks the repair sessions of 2026-09-14 → 16 ran by
 * hand against production, turned into a query that runs when the screen opens.
 * Nothing is stored except a person's «ليست مشكلة» (`data_quality_dismissals`):
 * a finding recomputed from the register cannot go stale, and one fixed in the
 * record simply stops being found.
 *
 * Read-only on every record. Fixing is done where it always was — the citizen's
 * edit form, the building editor, the owner-link queue.
 */
@Injectable()
export class DataQualityService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly landlordLinks: LandlordLinkService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async findings(filter: { includeDismissed?: boolean; officerId?: string } = {}) {
    const [staffNames, dismissals, ...groups] = await Promise.all([
      this.staffNames(),
      this.db.dataQualityDismissal.findMany({
        select: {
          kind: true,
          subjectKey: true,
          reason: true,
          createdAt: true,
          dismissedBy: { select: { firstName: true, lastName: true } },
        },
      }),
      this.duplicateCitizens(),
      this.heldAsPossibleDuplicate(),
      this.occupantsWithLandlordPhone(),
      this.nearDuplicateBuildings(),
      this.unitStatusContradictions(),
      this.buildingsWithoutPin(),
      this.unitsWithoutArea(),
      this.unlinkedLandlords(),
    ]);

    const dismissedBy = new Map(
      dismissals.map((row) => [
        `${row.kind}|${row.subjectKey}`,
        {
          reason: row.reason,
          by: row.dismissedBy ? `${row.dismissedBy.firstName} ${row.dismissedBy.lastName}` : null,
          at: row.createdAt.toISOString(),
        },
      ]),
    );

    const all: QualityFinding[] = groups.flat().map((finding) => ({
      ...finding,
      officers: finding.officerIds
        .filter((id, index, list) => id && list.indexOf(id) === index)
        .map((id) => ({ id, name: staffNames.get(id) ?? '—' })),
      dismissal: dismissedBy.get(`${finding.kind}|${finding.subjectKey}`) ?? null,
    })).map(({ officerIds: _ids, ...finding }) => finding);

    const visible = all
      .filter((finding) => filter.includeDismissed || !finding.dismissal)
      .filter((finding) => !filter.officerId || finding.officers.some((officer) => officer.id === filter.officerId))
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          (b.at ?? '').localeCompare(a.at ?? ''),
      );

    const counts = Object.fromEntries(
      [...new Set(all.map((finding) => finding.kind))].map((kind) => [
        kind,
        {
          open: all.filter((finding) => finding.kind === kind && !finding.dismissal).length,
          dismissed: all.filter((finding) => finding.kind === kind && finding.dismissal).length,
        },
      ]),
    );

    return { items: visible, counts };
  }

  async dismiss(input: DismissFindingInput, actor: { id: string; role: string }) {
    const existing = await this.db.dataQualityDismissal.findUnique({
      where: { kind_subjectKey: { kind: input.kind, subjectKey: input.subjectKey } },
      select: { id: true },
    });
    if (existing) throw new ConflictError('هذه الملاحظة مُعلَّمة «ليست مشكلة» بالفعل.');

    await this.db.dataQualityDismissal.create({
      data: { kind: input.kind, subjectKey: input.subjectKey, reason: input.reason, dismissedById: actor.id },
    });
    this.events.emit('quality.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: 'QUALITY_FINDING_DISMISSED',
      actorId: actor.id,
      actorRole: actor.role,
      after: { kind: input.kind, subjectKey: input.subjectKey, reason: input.reason },
    });
    return { dismissed: true };
  }

  async restore(kind: string, subjectKey: string, actor: { id: string; role: string }) {
    const existing = await this.db.dataQualityDismissal.findUnique({
      where: { kind_subjectKey: { kind, subjectKey } },
      select: { id: true, reason: true },
    });
    if (!existing) throw new NotFoundError('لا يوجد تعليم «ليست مشكلة» على هذه الملاحظة.');
    await this.db.dataQualityDismissal.delete({ where: { id: existing.id } });
    this.events.emit('quality.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: 'QUALITY_FINDING_RESTORED',
      actorId: actor.id,
      actorRole: actor.role,
      before: { kind, subjectKey, reason: existing.reason },
    });
    return { restored: true };
  }

  // ─────────────────────────────  Per officer  ─────────────────────────────

  /**
   * How each officer's filings are faring — beside, never inside, what they are
   * paid. Every figure is a count of something a person can open and look at.
   */
  async officerQuality(filter: { officerId?: string; from?: Date; to?: Date } = {}) {
    const range = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
    const hasRange = Boolean(filter.from || filter.to);

    const staff = await this.db.user.findMany({
      where: {
        kind: 'STAFF',
        ...(filter.officerId ? { id: filter.officerId } : {}),
        createdRegistrations: { some: hasRange ? { submittedAt: range } : {} },
      },
      select: { id: true, firstName: true, lastName: true, role: true, isActive: true },
      orderBy: [{ firstName: 'asc' }],
    });
    if (staff.length === 0) return { officers: [] };
    const ids = staff.map((row) => row.id);

    const [registrations, buildings, reviews, checks, findings, acknowledged] = await Promise.all([
      this.db.registration.findMany({
        where: { createdById: { in: ids }, ...(hasRange ? { submittedAt: range } : {}) },
        select: { createdById: true, flaggedFields: true },
      }),
      this.db.building.findMany({
        where: { createdById: { in: ids }, ...(hasRange ? { createdAt: range } : {}) },
        select: { createdById: true, latitude: true },
      }),
      this.db.recordReview.findMany({
        where: {
          registration: { createdById: { in: ids }, ...(hasRange ? { submittedAt: range } : {}) },
        },
        select: { outcome: true, resolvedAt: true, registration: { select: { createdById: true } } },
      }),
      this.db.qualityCheck.findMany({
        where: { originalOfficerId: { in: ids }, status: 'DONE', ...(hasRange ? { checkedAt: range } : {}) },
        select: { originalOfficerId: true, result: true },
      }),
      this.findings({}),
      this.db.$queryRaw<Array<{ actorId: string; count: number; nearest: number | null }>>`
        SELECT "actorId"::text AS "actorId",
               count(*)::int AS count,
               min((n->>'distanceMetres')::numeric)::float AS nearest
        FROM ${this.S}audit_log_entries a
        LEFT JOIN LATERAL jsonb_array_elements(COALESCE(a.after->'acknowledgedNeighbours', '[]'::jsonb)) n ON TRUE
        WHERE a.action = 'BUILDING_CREATED'
          AND a.after ? 'acknowledgedNeighbours'
          AND a."actorId" = ANY(${ids}::uuid[])
          ${filter.from ? Prisma.sql`AND a."createdAt" >= ${filter.from}` : Prisma.empty}
          ${filter.to ? Prisma.sql`AND a."createdAt" <= ${filter.to}` : Prisma.empty}
        GROUP BY a."actorId"
      `,
    ]);

    return {
      officers: staff.map((person) => {
        const mine = registrations.filter((row) => row.createdById === person.id);
        const flagged = mine.filter((row) => {
          const flags = Array.isArray(row.flaggedFields) ? (row.flaggedFields as unknown as FieldFlag[]) : [];
          return flags.some((flag) => flag.kind !== 'UNVERIFIED');
        }).length;
        const myBuildings = buildings.filter((row) => row.createdById === person.id);
        const myReviews = reviews.filter((row) => row.registration.createdById === person.id);
        const myChecks = checks.filter((row) => row.originalOfficerId === person.id);
        const differs = myChecks.filter((row) => row.result === 'DIFFERS').length;
        const myFindings = findings.items.filter((finding) =>
          finding.officers.some((officer) => officer.id === person.id),
        );
        const ack = acknowledged.find((row) => row.actorId === person.id);
        const countKind = (kind: QualityFindingKind) => myFindings.filter((finding) => finding.kind === kind).length;

        return {
          id: person.id,
          name: `${person.firstName} ${person.lastName}`,
          role: person.role,
          isActive: person.isActive,
          filed: mine.length,
          flaggedRecords: flagged,
          buildingsCreated: myBuildings.length,
          buildingsWithoutPin: myBuildings.filter((row) => row.latitude == null).length,
          reviews: {
            approved: myReviews.filter((row) => row.outcome === 'APPROVED').length,
            returned: myReviews.filter((row) => row.outcome === 'RETURNED').length,
            waitingOnOfficer: myReviews.filter((row) => row.outcome === 'RETURNED' && !row.resolvedAt).length,
          },
          checks: {
            done: myChecks.length,
            differs,
            differsRate: myChecks.length ? Math.round((differs / myChecks.length) * 100) : null,
          },
          findings: {
            open: myFindings.length,
            duplicateCitizens: countKind('DUPLICATE_CITIZEN') + countKind('HELD_AS_POSSIBLE_DUPLICATE'),
            landlordPhoneCopies: countKind('OCCUPANT_HAS_LANDLORD_PHONE'),
            nearDuplicateBuildings: countKind('NEAR_DUPLICATE_BUILDINGS'),
            statusContradictions: countKind('UNIT_STATUS_CONTRADICTION'),
          },
          acknowledgedDuplicateBuildings: {
            count: ack?.count ?? 0,
            nearestMetres: ack?.nearest != null ? Math.round(ack.nearest) : null,
          },
        };
      }),
    };
  }

  // ─────────────────────────────  The kinds  ─────────────────────────────

  private async staffNames(): Promise<Map<string, string>> {
    const rows = await this.db.user.findMany({
      where: { kind: 'STAFF' },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(rows.map((row) => [row.id, `${row.firstName} ${row.lastName}`]));
  }

  /**
   * One person filed twice — the same rule `CitizensService.create` asks by.
   *
   * Blocked on the folded first name, the folded family name and each number, so
   * a typo in one part is still compared through another; a block larger than
   * `MAX_BLOCK` (a very common first name in a very large town) is skipped and
   * the pair is still found through the family name or the phone.
   */
  private async duplicateCitizens(): Promise<RawFinding[]> {
    const people = await this.db.user.findMany({
      where: { kind: 'CITIZEN', isActive: true },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        motherName: true,
        phone: true,
        whatsapp: true,
        referenceNumber: true,
        createdAt: true,
        registrations: { orderBy: { submittedAt: 'desc' }, take: 1, select: { createdById: true } },
      },
    });

    const blocks = new Map<string, number[]>();
    const add = (key: string, index: number) => {
      if (!key) return;
      const list = blocks.get(key) ?? [];
      list.push(index);
      blocks.set(key, list);
    };
    people.forEach((person, index) => {
      add(`f:${foldNamePart(person.firstName)}`, index);
      add(`l:${foldNamePart(person.lastName)}`, index);
      if (person.phone) add(`p:${person.phone}`, index);
      if (person.whatsapp && person.whatsapp !== person.phone) add(`p:${person.whatsapp}`, index);
    });

    const seen = new Set<string>();
    const findings: RawFinding[] = [];
    for (const members of blocks.values()) {
      if (members.length < 2 || members.length > MAX_BLOCK) continue;
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const a = people[members[i]!]!;
          const b = people[members[j]!]!;
          const key = [a.id, b.id].sort().join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const signals = duplicateSignals(a, b);
          if (!isLikelySamePerson(signals)) continue;
          const on = matchedOn(signals);
          findings.push({
            kind: 'DUPLICATE_CITIZEN',
            subjectKey: key,
            severity: 'HIGH',
            detail: `تطابق في: ${on
              .map((part) => ({ NAME: 'الاسم', NAME_SIMILAR: 'اسم مشابه', PHONE: 'الهاتف', MOTHER: 'اسم الأم' })[part])
              .join('، ')}`,
            subjects: [a, b].map((person) => ({
              kind: 'citizen' as const,
              id: person.id,
              label: fullName(person),
              secondary: person.referenceNumber,
            })),
            officerIds: [a, b].map((person) => person.registrations[0]?.createdById ?? '').filter(Boolean),
            at: [a.createdAt, b.createdAt].sort((x, y) => y.getTime() - x.getTime())[0]!.toISOString(),
            dismissable: true,
          });
        }
      }
    }
    return findings;
  }

  /**
   * Filings delivered offline that the server held as possibly somebody already on file.
   *
   * Read from each citizen's newest registration only — the one whose flag the
   * edit form shows and clears. A flag on an older one could never be answered,
   * and this finding is not dismissable, so it would stand for good. The
   * registration path carries the flag forward when a filing is attached to
   * someone already on file, so nothing is lost by looking only here.
   */
  private async heldAsPossibleDuplicate(): Promise<RawFinding[]> {
    const rows = await this.db.$queryRaw<
      Array<{ id: string; citizenId: string; createdById: string | null; submittedAt: Date; reason: string | null }>
    >`
      SELECT r.id, r."citizenId", r."createdById", r."submittedAt",
             (SELECT f->>'reason' FROM jsonb_array_elements(r."flaggedFields") f
               WHERE f->>'path' = ${POSSIBLE_DUPLICATE_FLAG_PATH} LIMIT 1) AS reason
      FROM ${this.S}registrations r
      WHERE r."flaggedFields" @> ${JSON.stringify([{ path: POSSIBLE_DUPLICATE_FLAG_PATH }])}::jsonb
        AND r.id = (
          SELECT newest.id FROM ${this.S}registrations newest
           WHERE newest."citizenId" = r."citizenId"
           ORDER BY newest."submittedAt" DESC
           LIMIT 1
        )
    `;
    if (rows.length === 0) return [];
    const citizens = await this.citizenLabels(rows.map((row) => row.citizenId));
    return rows.map((row) => ({
      kind: 'HELD_AS_POSSIBLE_DUPLICATE' as const,
      subjectKey: row.id,
      severity: 'HIGH' as const,
      detail: row.reason ?? 'قد يكون مسجَّلاً مسبقاً',
      subjects: [citizens.get(row.citizenId)].filter((subject): subject is FindingSubject => Boolean(subject)),
      officerIds: row.createdById ? [row.createdById] : [],
      at: row.submittedAt.toISOString(),
      // Closed from the record's edit form, where the officer states it is a different person.
      dismissable: false,
    }));
  }

  /** An occupant whose own number is the landlord's number on their card, or their linked landlord's. */
  private async occupantsWithLandlordPhone(): Promise<RawFinding[]> {
    const rows = await this.db.$queryRaw<
      Array<{ entryId: string; citizenId: string; createdById: string | null; createdAt: Date; landlordName: string | null; field: string }>
    >`
      SELECT pe.id AS "entryId", u.id AS "citizenId", r."createdById", pe."createdAt",
             COALESCE(pe."landlordName", l."firstName" || ' ' || l."lastName") AS "landlordName",
             CASE
               WHEN u.phone IS NOT NULL AND (u.phone = pe."landlordPhone" OR u.phone = l.phone OR u.phone = l.whatsapp) THEN 'phone'
               ELSE 'whatsapp'
             END AS field
      FROM ${this.S}property_entries pe
      JOIN ${this.S}registrations r ON r.id = pe."registrationId"
      JOIN ${this.S}users u ON u.id = r."citizenId" AND u.kind = 'CITIZEN' AND u."isActive"
      LEFT JOIN ${this.S}users l ON l.id = pe."landlordCitizenId"
      WHERE pe."occupancyType" <> 'OWNER'
        AND pe."endedAt" IS NULL
        AND (
          (pe."landlordPhone" IS NOT NULL AND (u.phone = pe."landlordPhone" OR u.whatsapp = pe."landlordPhone"))
          OR (l.id IS NOT NULL AND l.id <> u.id AND (
                (l.phone IS NOT NULL AND (u.phone = l.phone OR u.whatsapp = l.phone))
             OR (l.whatsapp IS NOT NULL AND (u.phone = l.whatsapp OR u.whatsapp = l.whatsapp))))
        )
    `;
    if (rows.length === 0) return [];
    const citizens = await this.citizenLabels(rows.map((row) => row.citizenId));
    return rows.map((row) => ({
      kind: 'OCCUPANT_HAS_LANDLORD_PHONE' as const,
      subjectKey: row.entryId,
      severity: 'MEDIUM' as const,
      detail:
        row.field === 'phone'
          ? `رقم هاتف الشاغل هو رقم المالك${row.landlordName ? ` (${row.landlordName})` : ''} — قد يكون رقم العائلة المشترك`
          : `رقم واتساب الشاغل هو رقم المالك${row.landlordName ? ` (${row.landlordName})` : ''} — قد يكون رقم العائلة المشترك`,
      subjects: [citizens.get(row.citizenId)].filter((subject): subject is FindingSubject => Boolean(subject)),
      officerIds: row.createdById ? [row.createdById] : [],
      at: row.createdAt.toISOString(),
      dismissable: true,
    }));
  }

  /** Two pinned structures on one parcel, metres apart — the parcel 56 shape. */
  private async nearDuplicateBuildings(): Promise<RawFinding[]> {
    const buildings = await this.db.building.findMany({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: {
        id: true,
        code: true,
        name: true,
        parcelNumber: true,
        latitude: true,
        longitude: true,
        createdById: true,
        createdAt: true,
        unitsTotal: true,
      },
    });
    const byParcel = new Map<string, typeof buildings>();
    for (const building of buildings) {
      const list = byParcel.get(building.parcelNumber) ?? [];
      list.push(building);
      byParcel.set(building.parcelNumber, list);
    }

    const findings: RawFinding[] = [];
    for (const list of byParcel.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]!;
          const b = list[j]!;
          const metres = metresBetween(
            { latitude: a.latitude!, longitude: a.longitude! },
            { latitude: b.latitude!, longitude: b.longitude! },
          );
          if (metres >= NEAR_BUILDING_METRES) continue;
          findings.push({
            kind: 'NEAR_DUPLICATE_BUILDINGS',
            subjectKey: [a.id, b.id].sort().join(','),
            severity: 'HIGH',
            detail: `على بُعد ${Math.round(metres * 10) / 10} م على العقار ${a.parcelNumber} — ${a.unitsTotal} و${b.unitsTotal} وحدة`,
            subjects: [a, b].map((building) => ({
              kind: 'building' as const,
              id: building.id,
              label: building.name ? `${building.code} — ${building.name}` : building.code,
              secondary: `عقار ${building.parcelNumber}`,
            })),
            officerIds: [a.createdById ?? '', b.createdById ?? ''].filter(Boolean),
            at: [a.createdAt, b.createdAt].sort((x, y) => y.getTime() - x.getTime())[0]!.toISOString(),
            dismissable: true,
          });
        }
      }
    }
    return findings;
  }

  /**
   * The unit says one thing and the owner's own card another — X-78-A flat 0001
   * on 2026-09-16: «شاغرة» on the unit, «مشغولة من المالك» on the card. Billing
   * reads the unit, so the owner was charged nothing.
   */
  private async unitStatusContradictions(): Promise<RawFinding[]> {
    const rows = await this.db.$queryRaw<
      Array<{
        rowId: string;
        unitCode: string;
        unitStatus: string;
        cardStatus: string;
        buildingId: string;
        buildingCode: string;
        buildingName: string | null;
        parcelNumber: string;
        citizenId: string;
        createdById: string | null;
        updatedAt: Date;
      }>
    >`
      SELECT bu.id AS "rowId", u."unitCode", u."unitStatus"::text AS "unitStatus", bu."unitStatus"::text AS "cardStatus",
             b.id AS "buildingId", b.code AS "buildingCode", b.name AS "buildingName", b."parcelNumber",
             r."citizenId", r."createdById", GREATEST(bu."updatedAt", u."updatedAt") AS "updatedAt"
      FROM ${this.S}building_units bu
      JOIN ${this.S}property_entries pe ON pe.id = bu."propertyEntryId"
      JOIN ${this.S}registrations r ON r.id = pe."registrationId"
      JOIN ${this.S}units u ON u.id = bu."unitId"
      JOIN ${this.S}buildings b ON b.id = u."buildingId"
      WHERE bu."endedAt" IS NULL
        AND pe."endedAt" IS NULL
        AND pe."occupancyType" = 'OWNER'
        AND bu."unitStatus" IS NOT NULL
        AND u."unitStatus" IS NOT NULL
        AND bu."unitStatus"::text <> u."unitStatus"::text
    `;
    if (rows.length === 0) return [];
    const citizens = await this.citizenLabels(rows.map((row) => row.citizenId));
    return rows.map((row) => ({
      kind: 'UNIT_STATUS_CONTRADICTION' as const,
      subjectKey: row.rowId,
      severity: 'HIGH' as const,
      detail: `الوحدة ${row.unitCode}: على الوحدة «${row.unitStatus}» وعلى بطاقة المالك «${row.cardStatus}» — الفوترة تقرأ الوحدة`,
      subjects: [
        {
          kind: 'building' as const,
          id: row.buildingId,
          label: row.buildingName ? `${row.buildingCode} — ${row.buildingName}` : row.buildingCode,
          secondary: `عقار ${row.parcelNumber}`,
        },
        ...[citizens.get(row.citizenId)].filter((subject): subject is FindingSubject => Boolean(subject)),
      ],
      officerIds: row.createdById ? [row.createdById] : [],
      at: row.updatedAt.toISOString(),
      dismissable: true,
    }));
  }

  /** Structures with no entrance — the duplicate prompt cannot measure from them. */
  private async buildingsWithoutPin(): Promise<RawFinding[]> {
    const rows = await this.db.$queryRaw<
      Array<{ id: string; code: string; name: string | null; parcelNumber: string; createdById: string | null; createdAt: Date; reason: string | null }>
    >`
      SELECT b.id, b.code, b.name, b."parcelNumber", b."createdById", b."createdAt",
             (SELECT a.after->>'noPinReason' FROM ${this.S}audit_log_entries a
               WHERE a."entityType" = 'Building' AND a."entityId" = b.id::text AND a.action = 'BUILDING_CREATED'
               ORDER BY a."createdAt" DESC LIMIT 1) AS reason
      FROM ${this.S}buildings b
      WHERE b.latitude IS NULL
        AND b."lifecycleStatus"::text NOT IN ('DEMOLISHED', 'NOT_REALISED')
    `;
    return rows.map((row) => ({
      kind: 'BUILDING_WITHOUT_PIN' as const,
      subjectKey: row.id,
      severity: 'LOW' as const,
      detail: row.reason ? `السبب المذكور: ${row.reason}` : 'لم يُذكر سبب',
      subjects: [
        {
          kind: 'building' as const,
          id: row.id,
          label: row.name ? `${row.code} — ${row.name}` : row.code,
          secondary: `عقار ${row.parcelNumber}`,
        },
      ],
      officerIds: row.createdById ? [row.createdById] : [],
      at: row.createdAt.toISOString(),
      dismissable: true,
    }));
  }

  /**
   * Units somebody has been inside — an occupant recorded, or the survey
   * complete — with no area, one finding per building. Says how many had a
   * reason given (`unitAreaNotMeasured` on the occupancy's audit row).
   */
  private async unitsWithoutArea(): Promise<RawFinding[]> {
    const rows = await this.db.$queryRaw<
      Array<{
        buildingId: string;
        code: string;
        name: string | null;
        parcelNumber: string;
        createdById: string | null;
        units: number;
        withReason: number;
        latest: Date;
      }>
    >`
      WITH blank AS (
        SELECT u.id, u."buildingId", u."unitCode", u."updatedAt"
        FROM ${this.S}units u
        WHERE u."unitArea" IS NULL
          AND (
            u."surveyStatus"::text = 'COMPLETE'
            OR EXISTS (SELECT 1 FROM ${this.S}unit_occupancies o WHERE o."unitId" = u.id AND o."toDate" IS NULL)
          )
      )
      SELECT b.id AS "buildingId", b.code, b.name, b."parcelNumber", b."createdById",
             count(blank.id)::int AS units,
             count(blank.id) FILTER (WHERE EXISTS (
               SELECT 1 FROM ${this.S}audit_log_entries a
               WHERE a."entityType" = 'Building' AND a."entityId" = b.id::text
                 AND a.action = 'OCCUPANCY_RECORDED'
                 AND a.after->>'unitCode' = blank."unitCode"
                 AND a.after ? 'unitAreaNotMeasured'
             ))::int AS "withReason",
             max(blank."updatedAt") AS latest
      FROM blank
      JOIN ${this.S}buildings b ON b.id = blank."buildingId"
      GROUP BY b.id, b.code, b.name, b."parcelNumber", b."createdById"
    `;
    return rows.map((row) => ({
      kind: 'UNITS_WITHOUT_AREA' as const,
      subjectKey: row.buildingId,
      severity: 'LOW' as const,
      detail:
        row.withReason > 0
          ? `${row.units} وحدة مشغولة بلا مساحة — ذُكر السبب في ${row.withReason} منها`
          : `${row.units} وحدة مشغولة بلا مساحة — لم يُذكر سبب`,
      subjects: [
        {
          kind: 'building' as const,
          id: row.buildingId,
          label: row.name ? `${row.code} — ${row.name}` : row.code,
          secondary: `عقار ${row.parcelNumber}`,
        },
      ],
      officerIds: row.createdById ? [row.createdById] : [],
      at: row.latest.toISOString(),
      dismissable: true,
    }));
  }

  /** The owner-link queue's size, as one finding pointing at it. */
  private async unlinkedLandlords(): Promise<RawFinding[]> {
    const { total } = await this.landlordLinks.proposals({ limit: 1, offset: 0 });
    if (total === 0) return [];
    return [
      {
        kind: 'UNLINKED_LANDLORDS',
        subjectKey: 'queue',
        severity: 'MEDIUM',
        detail: `${total} بطاقة تذكر مالكاً مسجَّلاً ولم تُربط به بعد — من شاشة «روابط المالكين»`,
        subjects: [],
        officerIds: [],
        at: null,
        dismissable: false,
      },
    ];
  }

  private async citizenLabels(ids: readonly string[]): Promise<Map<string, FindingSubject>> {
    const rows = await this.db.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, firstName: true, middleName: true, lastName: true, referenceNumber: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { kind: 'citizen' as const, id: row.id, label: fullName(row), secondary: row.referenceNumber },
      ]),
    );
  }
}

type RawFinding = Omit<QualityFinding, 'officers' | 'dismissal'> & { officerIds: string[] };

