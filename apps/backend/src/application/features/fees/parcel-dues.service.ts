import { Injectable } from '@nestjs/common';
import {
  citizenDisplayName,
  type FeeAssessment,
  type ParcelDues,
  type ParcelDuesBill,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { parcelShareOf } from './parcel-dues';

interface OpenBillRow {
  id: string;
  citizenId: string;
  title: string;
  amount: unknown;
  paidAmount: unknown;
  dueDate: Date;
  status: 'UNPAID' | 'OVERDUE' | 'PENDING_REVIEW';
  assessment: FeeAssessment | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  residence: string | null;
}

/** Owed and not yet settled — the statuses `CorrectionBillsService` reads as open. */
const OPEN = ['UNPAID', 'OVERDUE', 'PENDING_REVIEW'];

/**
 * «ما المستحق على العقار» — what is still owed on one رقم العقار.
 *
 * Asked before a براءة ذمّة, and above all when an owner has died or sold: the
 * debt follows the property (the user's guidance of 2026-10-07), so the answer
 * is every open bill with a line on the parcel — whoever's file it sits on, an
 * estate's, a tenant's, an archived owner's — and the part of each that is the
 * parcel's (`parcelShareOf`). Bills that name no unit are listed apart, for the
 * people the register has on the parcel today. Read-only; it writes nothing and
 * certifies nothing.
 */
@Injectable()
export class ParcelDuesService {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async dues(propertyNumber: string): Promise<ParcelDues> {
    const S = this.S;
    const lineOnParcel = JSON.stringify([{ propertyNumber }]);
    const linked = await withConnectionRetry(() =>
      this.db.$queryRaw<OpenBillRow[]>`
        SELECT p.id, p."citizenId", p.title, p.amount, p."paidAmount", p."dueDate",
               p."paymentStatus"::text AS status, p.assessment,
               u."firstName", u."middleName", u."lastName", u.residence::text AS residence
          FROM ${S}citizen_payments p
          JOIN ${S}users u ON u.id = p."citizenId"
         WHERE p."paymentStatus"::text = ANY(${OPEN}::text[])
           AND jsonb_typeof(p.assessment -> 'lines') = 'array'
           AND p.assessment -> 'lines' @> ${lineOnParcel}::jsonb
         ORDER BY p."dueDate" ASC, p.id
      `,
    );

    /*
      The people on the parcel today: a current card with this رقم العقار, or
      an open spell in a building on it. Only their bills that name no unit —
      every bill that does is either above or not this parcel's.
    */
    const unlinkedRows = await withConnectionRetry(() =>
      this.db.$queryRaw<OpenBillRow[]>`
        WITH holders AS (
          SELECT r."citizenId"
            FROM ${S}property_entries e
            JOIN ${S}registrations r ON r.id = e."registrationId"
           WHERE e."propertyNumber" = ${propertyNumber} AND e."endedAt" IS NULL
          UNION
          SELECT o."citizenId"
            FROM ${S}unit_occupancies o
            JOIN ${S}units un ON un.id = o."unitId"
            JOIN ${S}buildings b ON b.id = un."buildingId"
           WHERE b."parcelNumber" = ${propertyNumber} AND o."toDate" IS NULL
        )
        SELECT p.id, p."citizenId", p.title, p.amount, p."paidAmount", p."dueDate",
               p."paymentStatus"::text AS status, p.assessment,
               u."firstName", u."middleName", u."lastName", u.residence::text AS residence
          FROM ${S}citizen_payments p
          JOIN holders h ON h."citizenId" = p."citizenId"
          JOIN ${S}users u ON u.id = p."citizenId"
         WHERE p."paymentStatus"::text = ANY(${OPEN}::text[])
           AND (jsonb_typeof(p.assessment -> 'lines') IS DISTINCT FROM 'array'
                OR jsonb_array_length(p.assessment -> 'lines') = 0)
         ORDER BY p."dueDate" ASC, p.id
      `,
    );

    const now = new Date();
    const base = (row: OpenBillRow) => ({
      paymentId: row.id,
      citizenId: row.citizenId,
      citizenName: citizenDisplayName(row, { middleName: false }),
      title: row.title,
      dueDate: row.dueDate.toISOString(),
      // OVERDUE is derived, as everywhere: a stored status lags the calendar.
      paymentStatus: row.status === 'UNPAID' && row.dueDate < now ? ('OVERDUE' as const) : row.status,
      remaining: Math.max(Number(row.amount) - Number(row.paidAmount), 0),
    });

    const bills: ParcelDuesBill[] = linked.flatMap((row) => {
      const part = parcelShareOf(row.assessment, propertyNumber);
      if (!part) return [];
      const bill = base(row);
      return [
        {
          ...bill,
          onParcel: part.wholeBill ? bill.remaining : Math.round(bill.remaining * part.share),
          unitCodes: part.unitCodes,
          wholeBill: part.wholeBill,
        },
      ];
    });
    const unlinked = unlinkedRows.map(base);

    return {
      propertyNumber,
      total: bills.reduce((sum, bill) => sum + bill.onParcel, 0),
      bills,
      unlinked,
      unlinkedTotal: unlinked.reduce((sum, bill) => sum + bill.remaining, 0),
    };
  }
}
