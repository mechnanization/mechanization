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

/** Arabic-Indic and Persian digits, and the Latin digit each maps to — `normalizeDigits` in SQL. */
const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const LATIN_DIGITS = '01234567890123456789';

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
    /*
      Compared digit-normalised on both sides. The query arrives in Latin
      digits (`parcelDuesQuerySchema`), but a card's رقم العقار — and the bill
      lines copied from it — are stored as typed, so «٤٢٠» would otherwise miss
      «420» and answer a false «لا شيء مستحق».
    */
    const [linked, unlinkedRows] = await Promise.all([
      withConnectionRetry(() =>
        this.db.$queryRaw<OpenBillRow[]>`
          SELECT p.id, p."citizenId", p.title, p.amount, p."paidAmount", p."dueDate",
                 p."paymentStatus"::text AS status, p.assessment,
                 u."firstName", u."middleName", u."lastName", u.residence::text AS residence
            FROM ${S}citizen_payments p
            JOIN ${S}users u ON u.id = p."citizenId"
           WHERE p."paymentStatus"::text = ANY(${OPEN}::text[])
             AND CASE WHEN jsonb_typeof(p.assessment -> 'lines') = 'array'
                      THEN EXISTS (
                        SELECT 1
                          FROM jsonb_array_elements(p.assessment -> 'lines') AS line
                         WHERE translate(btrim(line ->> 'propertyNumber'), ${EASTERN_DIGITS}, ${LATIN_DIGITS})
                               = ${propertyNumber}
                      )
                      ELSE false
                 END
           ORDER BY p."dueDate" ASC, p.id
        `,
      ),
      /*
        The people on the parcel today: a current card with this رقم العقار, or
        an open spell in a building on it. Only their bills that name no unit —
        every bill that does is either above or not this parcel's.
      */
      withConnectionRetry(() =>
        this.db.$queryRaw<OpenBillRow[]>`
          WITH holders AS (
            SELECT r."citizenId"
              FROM ${S}property_entries e
              JOIN ${S}registrations r ON r.id = e."registrationId"
             WHERE translate(btrim(e."propertyNumber"), ${EASTERN_DIGITS}, ${LATIN_DIGITS}) = ${propertyNumber}
               AND e."endedAt" IS NULL
            UNION
            SELECT o."citizenId"
              FROM ${S}unit_occupancies o
              JOIN ${S}units un ON un.id = o."unitId"
              JOIN ${S}buildings b ON b.id = un."buildingId"
             WHERE translate(btrim(b."parcelNumber"), ${EASTERN_DIGITS}, ${LATIN_DIGITS}) = ${propertyNumber}
               AND o."toDate" IS NULL
          )
          SELECT p.id, p."citizenId", p.title, p.amount, p."paidAmount", p."dueDate",
                 p."paymentStatus"::text AS status, p.assessment,
                 u."firstName", u."middleName", u."lastName", u.residence::text AS residence
            FROM ${S}citizen_payments p
            JOIN holders h ON h."citizenId" = p."citizenId"
            JOIN ${S}users u ON u.id = p."citizenId"
           WHERE p."paymentStatus"::text = ANY(${OPEN}::text[])
             -- CASE, not OR: Postgres may evaluate either side of an OR first,
             -- and jsonb_array_length fails on a non-array.
             AND CASE WHEN jsonb_typeof(p.assessment -> 'lines') = 'array'
                      THEN jsonb_array_length(p.assessment -> 'lines') = 0
                      ELSE true
                 END
           ORDER BY p."dueDate" ASC, p.id
        `,
      ),
    ]);

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
