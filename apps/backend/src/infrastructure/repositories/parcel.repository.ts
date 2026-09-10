import { Injectable } from '@nestjs/common';
import {
  ParcelLocation,
  ParcelRepository,
} from '../../domain/interfaces/parcel-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';
import { tenantSchemaPrefix } from '../prisma/tenant-schema-ref';
import { withConnectionRetry } from '../prisma/with-connection-retry';

@Injectable()
export class PrismaParcelRepository implements ParcelRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /** Schema prefix for this class's one raw query — see `tenant-schema-ref.ts`. */
  private get schemaPrefix(): string {
    return tenantSchemaPrefix(this.tenantContext.schemaName);
  }

  async count(): Promise<number> {
    return withConnectionRetry(() => this.db.parcel.count());
  }

  async findByNumber(parcelNumber: string): Promise<ParcelLocation | null> {
    const row = await withConnectionRetry(() =>
      this.db.parcel.findUnique({ where: { parcelNumber: parcelNumber.trim() } }),
    );
    return row ? toLocation(row) : null;
  }

  async findManyByNumber(
    parcelNumbers: readonly string[],
  ): Promise<Map<string, ParcelLocation>> {
    const wanted = [...new Set(parcelNumbers.map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) return new Map();

    const rows = await withConnectionRetry(() =>
      this.db.parcel.findMany({ where: { parcelNumber: { in: wanted } } }),
    );
    return new Map(rows.map((row) => [row.parcelNumber, toLocation(row)]));
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
   * Non-digits are stripped first so "15x" still anchors on 15.
   */
  async suggest(input: string, limit: number): Promise<string[]> {
    const digits = input.replace(/\D/g, '');
    if (!digits) return [];

    // Parcel numbers top out in the low thousands; the clamp keeps a pasted
    // 40-character string from overflowing the bigint cast below.
    const anchor = Number(digits.slice(0, 9));

    const rows = await this.db.$queryRawUnsafe<Array<{ parcelNumber: string }>>(
      `SELECT "parcelNumber" FROM (
        SELECT "parcelNumber",
               CAST(split_part(split_part("parcelNumber", '/', 1), '-', 1) AS bigint) AS root_num
        FROM ${this.schemaPrefix}"parcels"
        WHERE split_part(split_part("parcelNumber", '/', 1), '-', 1) ~ '^[0-9]+$'
      ) AS num_parcels
      ORDER BY abs(root_num - $1::bigint), root_num, "parcelNumber"
      LIMIT $2`,
      anchor,
      limit,
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
