import { AuditLogEntry } from '../../../domain/entities/audit-log-entry.entity';
import type { AuditRow } from '../../../domain/interfaces/audit-repository.interface';
import type { PrismaClient } from '../../../generated/tenant-client';

/**
 * An audit row as a person reads it: who, when, and what it was done to.
 *
 * ## Why the raw row was not enough
 *
 * `audit_log_entries` stores an actor id and an optional email, and most census
 * writes never had an email to store — so the screens printed «النظام» beside
 * every building an officer created, which is the one thing a trail must not
 * get wrong. The target was a bare uuid. Resolving both needs a handful of
 * lookups the table cannot do by itself, so they are made here, in one batch per
 * page, rather than one per line.
 *
 * ## Why values are redacted again on the way out
 *
 * `AuditLogEntry.create` redacts on write, but the hand-written
 * `DATA_CORRECTION` rows of 2026-09-14 → 16 were inserted straight into the
 * table and carry phone numbers inside their snapshots. Applying the same
 * redaction on read is what lets those rows be shown at all.
 */
export interface AuditActorView {
  kind: 'STAFF' | 'CITIZEN' | 'SYSTEM';
  /** A person's full name, or null where the account no longer exists. */
  name: string | null;
  role: string | null;
  email: string | null;
}

export interface AuditTargetView {
  type: string;
  id: string | null;
  /** «علي حسين بسام · BZR-2609-NCS3T6», «Z-3-56-C — بناية …» — null when unknown. */
  label: string | null;
  /** A short second line: a role, a case type, a parcel. */
  secondary: string | null;
  /** Where a screen can open it, as a kind the frontend maps to a route. */
  link: { kind: 'citizen' | 'staff' | 'building' | 'case' | 'zone'; id: string } | null;
  /** The id resolved to nothing — the record was deleted since. */
  missing: boolean;
}

export interface AuditView extends AuditRow {
  actor: AuditActorView;
  target: AuditTargetView;
}

const fullName = (row: { firstName: string; middleName?: string | null; lastName: string }) =>
  [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hand-written correction rows sometimes name two records in one `entityId`,
 * comma-joined. Split, so each is resolved and the label names both.
 */
function idsOf(entityId: string | null): string[] {
  if (!entityId) return [];
  return entityId
    .split(',')
    .map((part) => part.trim())
    .filter((part) => UUID.test(part));
}

const STATIC_TARGETS: Record<string, string> = {
  Tenant: 'سجل البلدية بالكامل',
  SystemSettings: 'إعدادات البلدية',
  Parcel: 'المسح العقاري',
  DataQuality: 'مراجعة الجودة',
};

export async function toAuditViews(db: PrismaClient, rows: readonly AuditRow[]): Promise<AuditView[]> {
  const idsByType = (type: string) => [
    ...new Set(rows.filter((row) => row.entityType === type).flatMap((row) => idsOf(row.entityId))),
  ];

  const actorIds = rows.map((row) => row.actorId).filter((id): id is string => Boolean(id && UUID.test(id)));
  const userIds = [...new Set([...actorIds, ...idsByType('User')])];

  const [users, buildings, cases, zones, registrations, notices, payments, documents] = await Promise.all([
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            kind: true,
            firstName: true,
            middleName: true,
            lastName: true,
            role: true,
            email: true,
            referenceNumber: true,
          },
        })
      : [],
    idsByType('Building').length
      ? db.building.findMany({
          where: { id: { in: idsByType('Building') } },
          select: { id: true, code: true, name: true, parcelNumber: true },
        })
      : [],
    idsByType('Case').length
      ? db.case.findMany({
          where: { id: { in: idsByType('Case') } },
          select: { id: true, caseType: true, propertyNumber: true, buildingName: true },
        })
      : [],
    idsByType('Zone').length
      ? db.zone.findMany({ where: { id: { in: idsByType('Zone') } }, select: { id: true, code: true, name: true } })
      : [],
    idsByType('Registration').length
      ? db.registration.findMany({
          where: { id: { in: idsByType('Registration') } },
          select: {
            id: true,
            referenceNumber: true,
            citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } },
          },
        })
      : [],
    idsByType('FeeNotice').length
      ? db.feeNotice.findMany({ where: { id: { in: idsByType('FeeNotice') } }, select: { id: true, title: true } })
      : [],
    idsByType('Payment').length
      ? db.citizenPayment.findMany({
          where: { id: { in: idsByType('Payment') } },
          select: {
            id: true,
            title: true,
            citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } },
          },
        })
      : [],
    idsByType('Document').length
      ? db.document.findMany({
          where: { id: { in: idsByType('Document') } },
          select: {
            id: true,
            type: true,
            registration: {
              select: { citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } } },
            },
          },
        })
      : [],
  ]);

  const userById = new Map(users.map((row) => [row.id, row]));
  const buildingById = new Map(buildings.map((row) => [row.id, row]));
  const caseById = new Map(cases.map((row) => [row.id, row]));
  const zoneById = new Map(zones.map((row) => [row.id, row]));
  const registrationById = new Map(registrations.map((row) => [row.id, row]));
  const noticeById = new Map(notices.map((row) => [row.id, row]));
  const paymentById = new Map(payments.map((row) => [row.id, row]));
  const documentById = new Map(documents.map((row) => [row.id, row]));

  const actorOf = (row: AuditRow): AuditActorView => {
    const kind: AuditActorView['kind'] =
      row.actorType === 'CITIZEN' ? 'CITIZEN' : row.actorType === 'SYSTEM' ? 'SYSTEM' : 'STAFF';
    const person = row.actorId ? userById.get(row.actorId) : undefined;
    return {
      kind: person?.kind === 'STAFF' ? 'STAFF' : kind,
      name: person ? fullName(person) : null,
      role: row.actorRole ?? person?.role ?? null,
      email: row.actorEmail ?? person?.email ?? null,
    };
  };

  const targetOf = (row: AuditRow): AuditTargetView => {
    const ids = idsOf(row.entityId);
    const base: AuditTargetView = {
      type: row.entityType,
      id: row.entityId,
      label: STATIC_TARGETS[row.entityType] ?? null,
      secondary: null,
      link: null,
      missing: false,
    };
    if (ids.length === 0) return base;

    const labelled = (
      parts: Array<{ label: string; secondary?: string | null; link?: AuditTargetView['link'] } | null>,
    ): AuditTargetView => {
      const found = parts.filter((part): part is NonNullable<typeof part> => part !== null);
      if (found.length === 0) return { ...base, missing: true };
      return {
        ...base,
        label: found.map((part) => part.label).join('، '),
        secondary: found.length === 1 ? (found[0]!.secondary ?? null) : null,
        link: found.length === 1 ? (found[0]!.link ?? null) : null,
      };
    };

    switch (row.entityType) {
      case 'User':
        return labelled(
          ids.map((id) => {
            const person = userById.get(id);
            if (!person) return null;
            return person.kind === 'STAFF'
              ? { label: fullName(person), secondary: person.role, link: { kind: 'staff', id } }
              : {
                  label: fullName(person),
                  secondary: person.referenceNumber,
                  link: { kind: 'citizen', id },
                };
          }),
        );
      case 'Building':
        return labelled(
          ids.map((id) => {
            const building = buildingById.get(id);
            return building
              ? {
                  label: building.name ? `${building.code} — ${building.name}` : building.code,
                  secondary: `عقار ${building.parcelNumber}`,
                  link: { kind: 'building', id },
                }
              : null;
          }),
        );
      case 'Case':
        return labelled(
          ids.map((id) => {
            const found = caseById.get(id);
            return found
              ? {
                  label: found.buildingName || (found.propertyNumber ? `عقار ${found.propertyNumber}` : 'حالة'),
                  secondary: found.caseType,
                  link: { kind: 'case', id },
                }
              : null;
          }),
        );
      case 'Zone':
        return labelled(
          ids.map((id) => {
            const zone = zoneById.get(id);
            return zone ? { label: `${zone.code} — ${zone.name}`, link: { kind: 'zone', id } } : null;
          }),
        );
      case 'Registration':
        return labelled(
          ids.map((id) => {
            const registration = registrationById.get(id);
            return registration
              ? {
                  label: fullName(registration.citizen),
                  secondary: registration.referenceNumber,
                  link: { kind: 'citizen', id: registration.citizen.id },
                }
              : null;
          }),
        );
      case 'FeeNotice':
        return labelled(ids.map((id) => (noticeById.has(id) ? { label: noticeById.get(id)!.title } : null)));
      case 'Payment':
        return labelled(
          ids.map((id) => {
            const payment = paymentById.get(id);
            return payment
              ? {
                  label: fullName(payment.citizen),
                  secondary: payment.title,
                  link: { kind: 'citizen', id: payment.citizen.id },
                }
              : null;
          }),
        );
      case 'Document':
        return labelled(
          ids.map((id) => {
            const document = documentById.get(id);
            return document
              ? {
                  label: fullName(document.registration.citizen),
                  secondary: document.type,
                  link: { kind: 'citizen', id: document.registration.citizen.id },
                }
              : null;
          }),
        );
      default:
        return base;
    }
  };

  return rows.map((row) => ({
    ...row,
    before: AuditLogEntry.redact(asRecord(row.before)),
    after: AuditLogEntry.redact(asRecord(row.after)),
    actor: actorOf(row),
    target: targetOf(row),
  }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
