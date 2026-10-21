import type { Prisma } from '../../../generated/tenant-client';
import { withHouseFieldsOnRow } from '../citizens/card-flags';

/**
 * «هذا المنزل يصبح مبنى» — a structure that is on somebody's file as a «منزل»
 * getting a second unit (decision D28, 2026-10-17).
 *
 * ## Why a second unit is not just a second unit here
 *
 * A «منزل» card names no unit. It claims the one unit of a one-unit structure,
 * and every reader infers that from the unit count: the census sync, «إنهاء
 * الملكية», «إنهاء الإيجار», the edit form's card removal and the matrix's own
 * backing check. The moment a second unit exists, the inference fails
 * everywhere at once — the next save of the file closes the household's
 * occupancy of their own home, and recording them on the new unit opens a
 * second card beside the first. Production reached that state five times
 * (B-1-352-A, Z-5-201-A, A9-1225-A, A6-974-B, Z-3-52-A), each repaired by hand.
 *
 * So the officer is asked, and the answer is written, before the structure
 * changes shape:
 *
 *  - another level of the same home → no unit; the house's unit rises a level;
 *  - a separate unit → it is created, and every «منزل» card on the structure
 *    becomes a «مبنى» card whose one row names the house's unit, in the same
 *    transaction. Nothing has to infer it again.
 */

type Db = Prisma.TransactionClient;

/** The one unit of a structure somebody holds as a «منزل». */
export interface HouseUnit {
  id: string;
  buildingId: string;
  floor: number;
  levels: number;
  unitType: string;
  unitCode: string;
  side: string | null;
  unitArea: Prisma.Decimal | null;
}

/** A current «منزل» card that claims that unit by inference. */
export interface HouseCard {
  id: string;
  registrationId: string;
  citizenId: string;
  citizenName: string;
  occupancyType: string;
}

export interface HouseOnFile {
  unit: HouseUnit;
  cards: HouseCard[];
}

/**
 * The house one more unit on this structure would turn into a building, if
 * there is one: the structure has exactly one unit row (of any type — a «طابق
 * أعمدة» added under a house breaks the inference just as surely), and either
 * a current «منزل» card points at it without naming a unit, or the structure
 * is itself a «منزل مستقل» — which `assertUnitFits` refuses a second unit, so
 * the officer adding a storey to a house is asked rather than turned away.
 * `cards` is empty in that second case.
 */
export async function houseOnFile(
  db: Db,
  building: { id: string; structureType: string },
): Promise<HouseOnFile | null> {
  const buildingId = building.id;
  const units = await db.unit.findMany({
    where: { buildingId },
    take: 2,
    select: {
      id: true,
      buildingId: true,
      floor: true,
      levels: true,
      unitType: true,
      unitCode: true,
      side: true,
      unitArea: true,
    },
  });
  if (units.length !== 1) return null;

  const cards = await db.propertyEntry.findMany({
    where: {
      buildingId,
      propertyType: 'HOUSE',
      endedAt: null,
      units: { none: { endedAt: null } },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      registrationId: true,
      occupancyType: true,
      registration: {
        select: { citizenId: true, citizen: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  if (cards.length === 0 && building.structureType !== 'INDEPENDENT_HOUSE') return null;

  return {
    unit: units[0]!,
    cards: cards.map((card) => ({
      id: card.id,
      registrationId: card.registrationId,
      citizenId: card.registration.citizenId,
      citizenName: `${card.registration.citizen.firstName} ${card.registration.citizen.lastName}`,
      occupancyType: card.occupancyType,
    })),
  };
}

/** One card `promoteHouseCards` changed, for the audit written after commit. */
export interface PromotedCard {
  propertyEntryId: string;
  citizenId: string;
  occupancyType: string;
  unitCode: string;
  /** What the card said of the house before it became a row, so the trail can show it moved, not changed. */
  moved: { unitArea: number | null; side: string | null; unitStatus: string | null };
  flagsMoved: boolean;
}

/**
 * Turns every «منزل» card on the structure into a «مبنى» card whose only row
 * names the house's unit. Called inside the transaction that adds the second
 * unit, after the unit exists and under the same lock.
 *
 * The card keeps its id — its landlord link, its documents, the registration it
 * was filed on and therefore the officer it credits all stay with it. What a
 * «منزل» carries itself and a «مبنى» carries on its row moves onto the row: the
 * area (the card's, else the unit's), the side, the shared rights and, on an
 * owner's card, حالة الوحدة. A «غير مؤكَّد» flag on one of those fields moves
 * with it (`withHouseFieldsOnRow`).
 *
 * A card that no longer qualifies by the time it is read — ended, retyped, or
 * given a row by a save that won the race — is left alone.
 */
export async function promoteHouseCards(db: Db, house: HouseOnFile): Promise<PromotedCard[]> {
  const promoted: PromotedCard[] = [];

  for (const { id } of house.cards) {
    const card = await db.propertyEntry.findUnique({
      where: { id },
      select: {
        id: true,
        registrationId: true,
        propertyType: true,
        occupancyType: true,
        endedAt: true,
        unitType: true,
        unitArea: true,
        side: true,
        sharedRights: true,
        unitStatus: true,
        registration: { select: { citizenId: true, flaggedFields: true } },
        units: { where: { endedAt: null }, select: { id: true } },
      },
    });
    if (!card || card.endedAt || card.propertyType !== 'HOUSE' || card.units.length > 0) continue;

    const owner = card.occupancyType === 'OWNER';
    await db.propertyEntry.update({
      where: { id: card.id },
      data: {
        propertyType: 'BUILDING',
        unitType: null,
        unitArea: null,
        side: null,
        sharedRights: [],
        unitStatus: null,
        floor: null,
        units: {
          create: {
            unitId: house.unit.id,
            unitType: house.unit.unitType as never,
            floor: String(house.unit.floor),
            side: card.side ?? house.unit.side,
            unitArea: card.unitArea ?? house.unit.unitArea,
            sharedRights: card.sharedRights,
            // حالة الوحدة is the owner's statement; a tenant's row carries none.
            unitStatus: owner ? card.unitStatus : null,
          },
        },
      },
    });

    // Its flags name it by position among the registration's current cards.
    const siblings = await db.propertyEntry.findMany({
      where: { registrationId: card.registrationId, endedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const index = siblings.findIndex((sibling) => sibling.id === card.id);
    const flags = withHouseFieldsOnRow(card.registration.flaggedFields, index);
    if (flags.changed) {
      await db.registration.update({
        where: { id: card.registrationId },
        data: { flaggedFields: flags.flags as never },
      });
    }

    promoted.push({
      propertyEntryId: card.id,
      citizenId: card.registration.citizenId,
      occupancyType: card.occupancyType,
      unitCode: house.unit.unitCode,
      moved: {
        unitArea: card.unitArea == null ? null : Number(card.unitArea),
        side: card.side,
        unitStatus: card.unitStatus,
      },
      flagsMoved: flags.changed,
    });
  }

  return promoted;
}
