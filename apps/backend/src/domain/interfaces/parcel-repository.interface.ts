/**
 * The municipality's official parcel registry, imported from the survey office's
 * cadastre. Like every other port here it takes no tenant argument — the
 * implementation reads the tenant-scoped client out of the request scope.
 */

export interface ParcelLocation {
  parcelNumber: string;
  latitude: number;
  longitude: number;
  /** The survey drew this parcel as several pieces; the point is their centroid. */
  approximate: boolean;
}

export interface ParcelRepository {
  /**
   * Zero means this municipality has not imported a cadastre, which the
   * application reads as "any well-formed رقم العقار is acceptable". Making that
   * an explicit check keeps a tenant onboarding before their survey data is
   * ready from having every submission rejected.
   */
  count(): Promise<number>;

  findByNumber(parcelNumber: string): Promise<ParcelLocation | null>;

  /** Batched lookup for a submission carrying several property cards. */
  findManyByNumber(parcelNumbers: readonly string[]): Promise<Map<string, ParcelLocation>>;

  /** Nearby numbers to offer when what the citizen typed is not in the cadastre. */
  suggest(prefix: string, limit: number): Promise<string[]>;

  /**
   * Rebuilds the registry wholesale from a fresh cadastre file. Whole-table
   * replace rather than an upsert-per-row: a corrected survey export removes
   * parcels as often as it adds them, and a partial update would leave stale
   * numbers resolvable that the new file no longer contains.
   *
   * `boundary` is the traced outline as a GeoJSON geometry, and is absent for
   * the parcels face-tracing could not close — those keep a null column, which
   * reads as "outline unknown" and never as "no area". It is written in the
   * same statement as the point rather than backfilled afterwards, so a parcel
   * can never be resolvable with a shape from the *previous* survey attached.
   */
  replaceAll(
    parcels: readonly {
      parcelNumber: string;
      latitude: number;
      longitude: number;
      pointCount: number;
      boundary?: unknown;
    }[],
  ): Promise<void>;
}
