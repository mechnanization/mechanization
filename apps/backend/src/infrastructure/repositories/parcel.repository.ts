import { Injectable } from '@nestjs/common';
import { EASTERN_DIGITS, LATIN_DIGITS, normalizeDigits } from '@mechanization/shared-schemas';
import {
  ParcelLocation,
  ParcelRepository,
  parcelNumberKey,
} from '../../domain/interfaces/parcel-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';
import { tenantSchemaPrefix, tenantSchemaRef } from '../prisma/tenant-schema-ref';
import { withConnectionRetry } from '../prisma/with-connection-retry';

interface ParcelRow {
  parcelNumber: string;
  latitude: number;
  longitude: number;
  pointCount: number;
}

@Injectable()
export class PrismaParcelRepository implements ParcelRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /** Schema prefix for `suggest`'s raw query — see `tenant-schema-ref.ts`. */
  private get schemaPrefix(): string {
    return tenantSchemaPrefix(this.tenantContext.schemaName);
  }

  async count(): Promise<number> {
    return withConnectionRetry(() => this.db.parcel.count());
  }

  async findByNumber(parcelNumber: string): Promise<ParcelLocation | null> {
    const found = await this.findManyByNumber([parcelNumber]);
    return found.get(parcelNumberKey(parcelNumber)) ?? null;
  }

  /**
   * Compared digit-normalised on both sides: the number asked for through
   * `parcelNumberKey`, the stored one through `translate`, because a survey
   * label and a typed رقم العقار are both kept as written. A seq scan, which a
   * cadastre of a few thousand rows does not notice.
   */
  async findManyByNumber(
    parcelNumbers: readonly string[],
  ): Promise<Map<string, ParcelLocation>> {
    const wanted = [...new Set(parcelNumbers.map(parcelNumberKey).filter(Boolean))];
    if (wanted.length === 0) return new Map();

    const rows = await withConnectionRetry(() =>
      this.db.$queryRaw<ParcelRow[]>`
        SELECT "parcelNumber", latitude, longitude, "pointCount"
          FROM ${this.S}parcels
         WHERE translate(btrim("parcelNumber"), ${EASTERN_DIGITS}, ${LATIN_DIGITS}) = ANY(${wanted}::text[])
         ORDER BY "parcelNumber"`,
    );

    // One survey never labels a parcel both ways; if one did, the first by
    // stored value answers, every time.
    const found = new Map<string, ParcelLocation>();
    for (const row of rows) {
      const key = parcelNumberKey(row.parcelNumber);
      if (!found.has(key)) found.set(key, toLocation(row));
    }
    return found;
  }

  /**
   * Nearest real parcel numbers, ordered by numeric distance rather than by
   * prefix.
   *
   * Prefix matching answers the wrong question here. This runs only after a
   * number failed to resolve, and the failures that matter are transposed or
   * fat-fingered digits — someone who types 1934 meant 1933, and no parcel
   * begins with "1934" to offer them. Distance surfaces the neighbours; a
   * prefix search surfaces nothing at all.
   *
   * Non-digits are stripped first so "15x" still anchors on 15. Digits are
   * compared in Latin on both sides, so «١٩٣٤» anchors on 1934 and a label
   * stored in Arabic digits is still a neighbour.
   */
  async suggest(input: string, limit: number): Promise<string[]> {
    const digits = normalizeDigits(input).replace(/\D/g, '');
    if (!digits) return [];

    // Parcel numbers top out in the low thousands; the clamp keeps a pasted
    // 40-character string from overflowing the bigint cast below.
    const anchor = Number(digits.slice(0, 9));

    const rows = await this.db.$queryRawUnsafe<Array<{ parcelNumber: string }>>(
      `SELECT "parcelNumber" FROM (
        SELECT "parcelNumber",
               CAST(split_part(split_part(latin, '/', 1), '-', 1) AS bigint) AS root_num
        FROM (
          SELECT "parcelNumber", translate(btrim("parcelNumber"), $3, $4) AS latin
          FROM ${this.schemaPrefix}"parcels"
        ) AS typed
        WHERE split_part(split_part(latin, '/', 1), '-', 1) ~ '^[0-9]+$'
      ) AS num_parcels
      ORDER BY abs(root_num - $1::bigint), root_num, "parcelNumber"
      LIMIT $2`,
      anchor,
      limit,
      EASTERN_DIGITS,
      LATIN_DIGITS,
    );

    return rows.map((row) => row.parcelNumber);
  }

  async replaceAll(
    parcels: readonly {
      parcelNumber: string;
      latitude: number;
      longitude: number;
      pointCount: number;
      boundary?: unknown;
    }[],
  ): Promise<void> {
    await this.db.$transaction([
      this.db.parcel.deleteMany({}),
      this.db.parcel.createMany({ data: parcels as never }),
    ]);
  }
}

function toLocation(row: {
  parcelNumber: string;
  latitude: number;
  longitude: number;
  pointCount: number;
}): ParcelLocation {
  return {
    parcelNumber: row.parcelNumber,
    latitude: row.latitude,
    longitude: row.longitude,
    approximate: row.pointCount > 1,
  };
}
