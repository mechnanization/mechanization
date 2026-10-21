import type { Prisma } from '../../generated/tenant-client';

/**
 * How every pay reader loads the work the earnings rule is applied to: the
 * roster (`PrismaUserRepository.listStaff`), the inspector's page
 * (`StaffService.getInspectorProfile`) and a merge's pay preview
 * (`CitizenMergeService.payImpact`). One shape, so the three cannot read
 * different work and disagree about the same officer.
 *
 * The rule itself — who is paid for a line, and once per flat — lives in
 * `packages/shared-schemas/src/inspector-earnings.ts` (`cardsCreditedTo`).
 */

/**
 * The columns of a card the earnings rule reads — `endReason` on both levels,
 * the unit's type and census link, who filed each line (0096), and where a
 * merge filed the card. Selecting only `id` here is what once let the roster
 * disagree with the inspector's own page.
 *
 * `createdAt` on a line dates the credit for a line an officer added to
 * somebody else's file: that is when he earned it, not when the file was made.
 */
export const EARNINGS_CARD_SELECT = {
  id: true,
  propertyType: true,
  endReason: true,
  filedRegistrationId: true,
  units: {
    select: { id: true, unitId: true, unitType: true, endReason: true, filedById: true, createdAt: true },
  },
} as const satisfies Prisma.PropertyEntrySelect;

/**
 * The registrations that can credit any of `officerIds`: those they registered,
 * and those holding a line one of them filed — on a card that sits on the
 * registration, or on one a merge moved off it and still credits it
 * (`movedCards`, see `cardsFiledOn`).
 */
export function creditedRegistrationsWhere(officerIds: readonly string[]): Prisma.RegistrationWhereInput {
  const filedByThem = { units: { some: { filedById: { in: [...officerIds] } } } };
  return {
    OR: [
      { createdById: { in: [...officerIds] } },
      { properties: { some: filedByThem } },
      { movedCards: { some: filedByThem } },
    ],
  };
}
