import { cardClaiming, claimsFlat, takesAnotherFlat } from './census-claim';

/**
 * The rule four call sites read a claim through, on its own.
 *
 * It is tested here as well as through `recordOccupancy` because the thing
 * that went wrong on 2026-09-19 was not a path — it was an inference, made
 * from the building's unit count, which was correct on the day the card was
 * filed and wrong the day the structure grew. An inference that cannot be
 * exercised without a service is one nobody re-reads.
 */

const FLAT = 'unit-1';
const OTHER = 'unit-2';

const house = (over: Partial<{ occupancyType: string; units: Array<{ unitId: string | null }> }> = {}) => ({
  propertyType: 'HOUSE',
  occupancyType: 'OWNER',
  units: [] as Array<{ unitId: string | null }>,
  ...over,
});
const building = (units: Array<{ unitId: string | null }> = [], occupancyType = 'OWNER') => ({
  propertyType: 'BUILDING',
  occupancyType,
  units,
});
const spell = (unitId: string, role = 'OWNER') => ({ unitId, role });

describe('claimsFlat — the three shapes a claim comes in', () => {
  it('reads a row naming the flat, whatever the card is', () => {
    const cards = [building([{ unitId: FLAT }])];
    expect(claimsFlat(cards, [], FLAT)(cards[0]!)).toBe(true);
  });

  it('reads a مبنى with no rows as claiming everything they hold there', () => {
    // The same statement `heldThroughOccupancy` bills it by.
    const cards = [building()];
    expect(claimsFlat(cards, [spell(FLAT)], FLAT)(cards[0]!)).toBe(true);
  });

  it('reads a منزل as this flat while it is the only one they hold unnamed', () => {
    const cards = [house()];
    expect(claimsFlat(cards, [spell(FLAT)], FLAT)(cards[0]!)).toBe(true);
  });

  it('is unchanged where the census holds no spell at all', () => {
    // A card filed before the matrix existed. Nothing contradicts it, so it
    // still claims the flat — the old single-unit inference's answer, without
    // the building's unit count being consulted.
    const cards = [house()];
    expect(claimsFlat(cards, [], FLAT)(cards[0]!)).toBe(true);
  });
});

describe('claimsFlat — a منزل on a structure that has grown', () => {
  /*
    Z-5-201-A, 2026-09-19: a 130 m² منزل card, then a second unit, then the
    same man recorded as its owner. The tick went onto the منزل card and
    `billableUnits` stopped reading the columns — 9 m² assessed, the home not
    assessed at all.
  */
  it('does not let one منزل card claim a second flat', () => {
    const cards = [house()];
    const claims = claimsFlat(cards, [spell('unit-home'), spell(FLAT)], FLAT);
    expect(claims(cards[0]!)).toBe(false);
  });

  it('claims neither of the two while one card could be about either', () => {
    /*
      Symmetric, and deliberately so: the card does not say which flat it is,
      so nothing here may decide. Whichever flat is recorded next gets a card
      naming it, and the question answers itself on the following read — see
      the test below.

      The cost is one extra card if the *card's own* flat is the one recorded
      while a second unnamed spell is standing. That needs an owner spell with
      no card behind it, which every path that writes one closes in the same
      breath (`applyUnits` files each flat before it moves to the next).
    */
    const cards = [house()];
    expect(claimsFlat(cards, [spell('unit-home'), spell(FLAT)], 'unit-home')(cards[0]!)).toBe(false);
  });

  it('lets a row on another card account for the flat it names', () => {
    // Once the second flat is on a card of its own, the منزل is unambiguous
    // again: the spell that made it ambiguous is named elsewhere.
    const cards = [house(), building([{ unitId: OTHER }])];
    const claims = claimsFlat(cards, [spell(OTHER), spell(FLAT)], FLAT);
    expect(claims(cards[0]!)).toBe(true);
  });

  it('counts the cards rather than matching them', () => {
    // Two column-billing cards cover two flats between them; three flats and
    // two cards leave one for a card of its own.
    const two = [house(), house()];
    expect(claimsFlat(two, [spell('unit-home'), spell(FLAT)], FLAT)(two[0]!)).toBe(true);
    expect(
      claimsFlat(two, [spell('unit-home'), spell('unit-shop'), spell(FLAT)], FLAT)(two[0]!),
    ).toBe(false);
  });

  it('counts within one capacity, never across', () => {
    // A flat they rent says nothing about the منزل they own, and the owner's
    // card must not be spent accounting for it.
    const cards = [house()];
    const claims = claimsFlat(cards, [spell('unit-let', 'TENANT'), spell(FLAT)], FLAT);
    expect(claims(cards[0]!)).toBe(true);
  });
});

describe('takesAnotherFlat', () => {
  it('refuses a card that bills from its own columns', () => {
    // A row here would stop those columns being read — the defect itself.
    expect(takesAnotherFlat(house())).toBe(false);
  });

  it('accepts a card that already itemises', () => {
    expect(takesAnotherFlat(house({ units: [{ unitId: OTHER }] }))).toBe(true);
    expect(takesAnotherFlat(building())).toBe(true);
  });
});

describe('cardClaiming', () => {
  it('prefers the card of the capacity being recorded', () => {
    const cards = [
      { ...building([{ unitId: FLAT }], 'TENANT'), id: 'tenancy' },
      { ...building([{ unitId: FLAT }], 'OWNER'), id: 'ownership' },
    ];
    expect(cardClaiming(cards, [], FLAT, 'OWNER')?.id).toBe('ownership');
  });

  it('falls back to any capacity, so the flat is never filed twice', () => {
    // A flat on a card of the wrong capacity is a correction for a person to
    // make, not one to paper over by filing it again.
    const cards = [{ ...building([{ unitId: FLAT }], 'TENANT'), id: 'tenancy' }];
    expect(cardClaiming(cards, [], FLAT, 'OWNER')?.id).toBe('tenancy');
  });

  it('finds nothing when nothing claims it', () => {
    const cards = [{ ...building([{ unitId: OTHER }]), id: 'elsewhere' }];
    expect(cardClaiming(cards, [spell(FLAT)], FLAT, 'OWNER')).toBeUndefined();
  });
});
