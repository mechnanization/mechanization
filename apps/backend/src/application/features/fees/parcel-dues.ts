import type { FeeAssessment } from '@mechanization/shared-schemas';

/**
 * The part of a bill that is one parcel's, by the bill's own lines.
 *
 * A bill charges units, and its lines say which and how much of each: a
 * PER_AREA line weighs its area, a PER_UNIT line one unit, and a co-owned
 * flat's line its owner's part. A bill wholly on the parcel is all of it; a
 * bill over two parcels is split by those weights — never guessed from the
 * citizen's current cards, which may have changed since the bill was raised.
 * Null when the bill has no line on the parcel.
 */
export function parcelShareOf(
  assessment: FeeAssessment | null | undefined,
  propertyNumber: string,
): { share: number; unitCodes: string[]; wholeBill: boolean } | null {
  const lines = assessment?.lines ?? [];
  const here = lines.filter((line) => line.propertyNumber === propertyNumber);
  if (here.length === 0) return null;

  const weight = (line: (typeof lines)[number]) =>
    (assessment!.basis === 'PER_AREA' ? (line.unitArea ?? 0) : 1) *
    (line.ownerShare ? line.ownerShare.numerator / line.ownerShare.denominator : 1);
  const total = lines.reduce((sum, line) => sum + weight(line), 0);
  const mine = here.reduce((sum, line) => sum + weight(line), 0);
  const wholeBill = here.length === lines.length;

  return {
    share: wholeBill ? 1 : total > 0 ? mine / total : here.length / lines.length,
    unitCodes: [...new Set(here.map((line) => line.unitCode).filter((code): code is string => Boolean(code)))],
    wholeBill,
  };
}
