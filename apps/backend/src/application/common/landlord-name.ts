import { storedLandlordName } from '@mechanization/shared-schemas';
import type { Prisma } from '../../generated/tenant-client';

/**
 * The owner's name each submitted card writes to `property_entries.landlordName`.
 *
 * `storedLandlordName`, given the owner a card names in `landlordCitizenId`
 * (the officer's «نعم، هو المالك», or a standing link the form sent back), so
 * the name the form was *shown* for that owner is stored as the owner's own.
 * Every owner of the submission is read in one query. The entity has already
 * taken «ورثة المرحوم» off; this adds only the owner refinement.
 */
export async function landlordNamesToStore(
  db: Pick<Prisma.TransactionClient, 'user'>,
  cards: ReadonlyArray<{ landlordName?: string | null; landlordCitizenId?: unknown }>,
): Promise<Array<string | null>> {
  const ids = [
    ...new Set(
      cards
        .filter((card) => card.landlordName)
        .map((card) => card.landlordCitizenId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const owners = ids.length
    ? await db.user.findMany({
        where: { id: { in: ids }, kind: 'CITIZEN' },
        select: { id: true, firstName: true, middleName: true, lastName: true, residence: true },
      })
    : [];
  const byId = new Map(owners.map((owner) => [owner.id, owner]));
  return cards.map((card) =>
    storedLandlordName(
      card.landlordName,
      typeof card.landlordCitizenId === 'string' ? byId.get(card.landlordCitizenId) : null,
    ),
  );
}
