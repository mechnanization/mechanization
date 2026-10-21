import type { Prisma } from '../../generated/tenant-client';

/**
 * The first «منزل» card here linked to a structure that holds more than one
 * unit, if any — the shape decision D28 retires.
 *
 * A «منزل» card names no unit: it claims the one unit of a one-unit structure,
 * and every reader infers that from the unit count. On a structure with two
 * units it claims nothing the census can see, so the household's occupancy is
 * never backed and recording them on a flat opens a second card. The matrix
 * now converts the cards a house already has when it grows
 * (`promoteHouseCards`); this is the other door — a filing or an edit
 * *creating* one, from a form or an older client's offline queue — refused at
 * the write, since the officer can pick «مبنى» and its flat instead.
 *
 * Counts every unit row, as the readers do: a «طابق أعمدة» beside the house
 * breaks the inference just as surely as a second flat.
 */
export async function houseCardOnMultiUnitBuilding(
  db: Prisma.TransactionClient,
  cards: ReadonlyArray<{ propertyType?: string | null; buildingId?: string | null }>,
): Promise<{ index: number; buildingCode: string } | null> {
  const linked = cards
    .map((card, index) => ({ index, buildingId: card.propertyType === 'HOUSE' ? card.buildingId : null }))
    .filter((card): card is { index: number; buildingId: string } => Boolean(card.buildingId));
  if (linked.length === 0) return null;

  const counts = await db.unit.groupBy({
    by: ['buildingId'],
    where: { buildingId: { in: [...new Set(linked.map((card) => card.buildingId))] } },
    _count: { _all: true },
  });
  const crowded = new Set(counts.filter((row) => row._count._all > 1).map((row) => row.buildingId));
  const offending = linked.find((card) => crowded.has(card.buildingId));
  if (!offending) return null;

  const building = await db.building.findUnique({
    where: { id: offending.buildingId },
    select: { code: true },
  });
  return { index: offending.index, buildingCode: building?.code ?? '' };
}
