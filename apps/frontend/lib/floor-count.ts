/**
 * «عدد الطوابق المسقوفة» — the top rows of a building's matrix that hold nothing.
 *
 * The count is every built level under a roof, the ground floor and a «طابق
 * أعمدة» among them; the roof itself is never a floor (the user's decision of
 * 2026-10-07: count only the floors that are built and covered). The audit of
 * that day found 75 buildings whose top row was empty — the roof counted, or
 * the editor's old default of three left standing — and every screen that
 * says «3 طوابق» repeats the mistake.
 *
 * So a gap at the top is worth saying, never fixing silently: it can also be
 * a storey nobody has surveyed yet, or the upper level of a duplex recorded as
 * one flat below it. The officer decides; this only measures.
 *
 * `units` are every unit on the building, drawn or not (basements are
 * negative and do not count here). Null when nothing is drawn above ground —
 * an empty matrix says nothing about its height — when the top row holds
 * something, or when a unit is a whole house («منزل مستقل»): a house is one
 * unit on the ground row however many storeys it has, so its empty rows above
 * are the house itself.
 */
export function emptyTopFloors(
  units: ReadonlyArray<{ floor: number; unitType?: string | null }>,
  floorsCount: number,
): { empty: number; suggested: number } | null {
  if (units.some((unit) => unit.unitType === 'INDEPENDENT_HOUSE')) return null;
  const above = units.map((unit) => unit.floor).filter((floor) => floor >= 0);
  if (above.length === 0) return null;
  const suggested = Math.max(...above) + 1;
  const empty = floorsCount - suggested;
  return empty > 0 ? { empty, suggested } : null;
}
