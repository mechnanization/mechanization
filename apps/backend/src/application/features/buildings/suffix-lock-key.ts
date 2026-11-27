/**
 * The advisory-lock key that serialises everything choosing a building's code
 * suffix on one parcel: `BuildingsService.create` and the parcel correction
 * (`ParcelCorrectionService`) both take it, and they meet only because the key
 * is the same string. Build it here and nowhere else.
 *
 * The schema is named in the key, never read from `current_schema()`: that
 * reads the pooled connection's `search_path`, which this app does not own, so
 * a drifted connection would return `public` and every municipality's parcel
 * 28 would serialise against every other's — or two officers on one parcel
 * would take different locks, and the suffix race would be back.
 */
export function buildingSuffixLockKey(schemaName: string, parcelNumber: string): string {
  return `${schemaName}:building-suffix:${parcelNumber}`;
}
