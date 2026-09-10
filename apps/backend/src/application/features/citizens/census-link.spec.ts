import { adminCreateCitizenSubmissionSchema } from '@mechanization/shared-schemas';

/**
 * The link from a property card to the censused structure it describes (P3-T6).
 *
 * This is the one thing P2-T8's authority rule turns on: where a card line
 * names a canonical `Unit`, that `Unit` wins field by field, and the flat the
 * citizen filed and the flat the municipality surveyed are known to be the same
 * flat rather than two rows that happen to agree.
 *
 * It is tested here, at the schema, because that is where it is most likely to
 * be lost and least likely to be noticed. `branchFieldsOnly` keeps only the
 * fields a card's نوع العقار declares, so a key it does not list is **silently
 * dropped** on its way to `partialPropertyEntrySchema` — no error, no
 * complaint, just a registration that arrives with no link and a census that
 * quietly never learns who lives in the building. Every assertion below is
 * about that failure mode.
 */
const submission = (card: Record<string, unknown>) => ({
  personal: { firstName: 'علي', lastName: 'نصرالله', isLebanese: true } as Record<string, unknown>,
  contact: { phone: '03 123456' } as Record<string, unknown>,
  properties: [card],
  flags: [] as Array<{ path: string; reason: string }>,
  /*
    The person is deliberately a stub, and the blanket reason is what makes that
    a valid record rather than a fixture with holes in it.

    These tests are about one field on a property card. Filling in a complete
    citizen to reach it would put twenty values in the way of the assertion and
    make the spec fail for reasons that have nothing to do with the link. The
    blanket reason is the mechanism the register already has for exactly this
    shape of record — see `blanket-reason.spec.ts` — and it cannot excuse
    anything on the card itself that these tests care about.
  */
  blanketFlagReason: 'الأسرة غائبة ولم يتوفر من يعطي البيانات',
});

const BUILDING_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';

const parse = (card: Record<string, unknown>) => {
  const result = adminCreateCitizenSubmissionSchema.safeParse(submission(card));
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.path.join('.')).join(', '));
  }
  return result.data.properties[0] as Record<string, unknown>;
};

const buildingCard = (extra: Record<string, unknown> = {}) => ({
  occupancyType: 'OWNER',
  propertyType: 'BUILDING',
  neighborhood: 'الحي الشرقي',
  propertyNumber: '1042',
  buildingName: 'بناية النور',
  units: [{ unitType: 'APARTMENT', floor: 'الأرضي', unitArea: 120, unitStatus: 'RENTED' }],
  ...extra,
});

describe('the census link on a property card', () => {
  it('carries buildingId through to the shaped card', () => {
    const card = parse(buildingCard({ buildingId: BUILDING_ID }));
    expect(card.buildingId).toBe(BUILDING_ID);
  });

  it('carries unitId on each unit line', () => {
    const card = parse(
      buildingCard({
        buildingId: BUILDING_ID,
        units: [
          { unitId: UNIT_ID, unitType: 'APARTMENT', floor: '1', unitArea: 95, unitStatus: 'RENTED' },
        ],
      }),
    );
    const units = card.units as Array<Record<string, unknown>>;
    expect(units[0]?.unitId).toBe(UNIT_ID);
  });

  it('accepts a منزل card with a link, since a house stands on a structure too', () => {
    const card = parse({
      occupancyType: 'OWNER',
      propertyType: 'HOUSE',
      neighborhood: 'الحي الغربي',
      propertyNumber: '1043',
      buildingName: 'منزل خليل',
      unitArea: 180,
      unitStatus: 'OWNER_OCCUPIED',
      buildingId: BUILDING_ID,
    });
    expect(card.buildingId).toBe(BUILDING_ID);
  });

  it('drops a link on أرض, which has nothing standing on it', () => {
    /*
      Not an error — a *removal*, and deliberately so. `LAND` is absent from
      `STRUCTURE_TYPE_MAP` because land never gets a building, so a client that
      sent one is confused rather than malicious, and the correct answer is a
      land card with no link rather than a rejected registration.
    */
    const card = parse({
      occupancyType: 'OWNER',
      propertyType: 'LAND',
      neighborhood: 'السهل',
      propertyNumber: '1044',
      landType: 'AGRICULTURAL',
      unitArea: 2400,
      shares: 400,
      buildingId: BUILDING_ID,
    });
    expect(card.buildingId).toBeUndefined();
  });

  it('drops a link on خيمة, which stays a bare card (Q2)', () => {
    // Tents have no permanent cadastral footprint and are not backfilled into
    // the census; `TENT_SHELTER` exists for a mapped settlement, not for this.
    const card = parse({
      occupancyType: 'FREE_OCCUPANT',
      propertyType: 'TENT',
      neighborhood: 'أطراف البلدة',
      propertyNumber: '1045',
      tentLocation: 'قرب البيادر الشرقية',
      landlordName: 'حسن خليل',
      buildingId: BUILDING_ID,
    });
    expect(card.buildingId).toBeUndefined();
  });

  it('leaves the link absent when the officer did not pick one', () => {
    // The overwhelmingly common case, and permanent rather than transitional: a
    // card filed on a parcel nobody has surveyed has nothing to link to.
    const card = parse(buildingCard());
    expect(card.buildingId).toBeUndefined();
  });

  it('refuses a buildingId that is not a UUID', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(
      submission(buildingCard({ buildingId: 'A-1042-B' })),
    );
    // The *code* is not the identity — the UUID is (D9). A client that sent the
    // printed code here would be pointing at nothing.
    expect(result.success).toBe(false);
  });
});
