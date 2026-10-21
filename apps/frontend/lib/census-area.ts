/**
 * A census area, copied down onto the card line that names its flat.
 *
 * `UnitFields` shows that area locked, so the officer cannot type over it, but
 * the save validates the line's *own* `unitArea`. An owner line stored with no
 * area (B-1-1626-A, 2026-10-21) then failed «المساحة يجب أن تكون رقماً» on a box
 * reading 20 that nobody could change, and the whole file stopped saving.
 *
 * Returns the corrected lines, or null when every line already agrees — so the
 * caller's effect converges, as the picker's name and parcel mirrors do. It
 * also repairs a line saved with an area the unit was later corrected away
 * from (175 on the card, 75 on the unit). A unit with no area leaves its line
 * alone: that field is open, and the officer is the one who measures it.
 */
export function mirrorCensusAreas<T extends { unitId?: string; unitArea?: string }>(
  lines: readonly T[],
  censusAreas: Readonly<Record<string, { unitArea: string | null } | undefined>>,
): T[] | null {
  let changed = false;
  const next = lines.map((line) => {
    const area = line.unitId ? censusAreas[line.unitId]?.unitArea : null;
    if (area == null || area === '' || Number(line.unitArea) === Number(area)) return line;
    changed = true;
    return { ...line, unitArea: area };
  });
  return changed ? next : null;
}
