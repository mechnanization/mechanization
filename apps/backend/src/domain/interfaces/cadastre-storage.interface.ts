/**
 * The port for a municipality's derived cadastre layers — `cadastre.geojson`,
 * `parcels.geojson`, `parcel-polygons.geojson`, `city-boundary.geojson`.
 *
 * It exists because the object store behind those layers has to be swappable,
 * and the concrete class was being injected by type in three places
 * (`CadastreAssetsService`, `CadastreImportService`, `CadastreController`).
 * TypeScript counts private members in structural assignability, so a second
 * class with an identical public surface is still not assignable to the first —
 * a Nest `useClass` swap against a concrete type does not type-check, however
 * faithfully the replacement copies the methods. Only a real interface makes
 * the swap expressible, which is also what the infrastructure layer says it is
 * for: "the application layer sees symbols".
 */
export interface CadastreStorage {
  /**
   * Writes `contents` as this tenant's `assetName`, replacing whatever the last
   * import left at that key. Re-importing a cadastre is a correction of the
   * previous layer, not a second copy sitting beside it.
   */
  upload(tenantSlug: string, assetName: string, contents: string): Promise<void>;

  /**
   * The raw text of the asset, or `null` when this tenant has not imported this
   * layer.
   *
   * `null` means "not imported", never "imported and empty", and callers must
   * keep the two apart. `CadastreAssetsService.getCityBoundary` already depends
   * on exactly this: it returns null so its callers *skip* the containment
   * check, because a caller that read null as "no shapes are inside this
   * municipality" would reject every parcel a municipality owns.
   *
   * The consequence for implementations: a failed request is indistinguishable
   * from an absent object once it has been flattened to `null` here, so an
   * implementation that returns `null` for a transient fault must log that
   * fault. Otherwise an outage presents to every reader as a municipality that
   * never imported a cadastre.
   */
  read(tenantSlug: string, assetName: string): Promise<string | null>;
}
