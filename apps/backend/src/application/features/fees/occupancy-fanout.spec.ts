import { attachOccupancies } from './fees.service';

/**
 * Which card gets a building's recorded occupancies — and why only one may.
 *
 * `heldThroughOccupancy` bills a مبنى card that itemises no flats from
 * `UnitOccupancy`, because that is the only per-citizen table that can say
 * which flats this person actually holds. The list was handed to every card
 * linked to the building and nothing deduped it, so two such cards on one block
 * billed the same flats twice — silently, with every row individually valid.
 *
 * These are unit tests rather than assertions inside an assessment because the
 * rule is about *which card* receives the list, and a test that assesses one
 * card in isolation cannot see that rule at all. That is precisely how the
 * defect survived a green suite.
 */
describe('attachOccupancies', () => {
  const held = [
    { role: 'OWNER', unitType: 'APARTMENT' },
    { role: 'OWNER', unitType: 'APARTMENT' },
  ];
  const byBuilding = new Map([['b1', held]]);

  it('gives a مبنى card with no unit rows the flats recorded for it', () => {
    const [card] = attachOccupancies(
      [{ buildingId: 'b1', propertyType: 'BUILDING', units: [] }],
      byBuilding,
    );
    expect(card?.occupiedUnits).toEqual(held);
  });

  it('bills two cards on one building once, not twice', () => {
    /*
      The defect, stated as a test. Two مبنى cards on block B and two flats
      recorded there used to yield four billable units — double the bill under
      a PER_UNIT notice.
    */
    const cards = attachOccupancies(
      [
        { buildingId: 'b1', propertyType: 'BUILDING', units: [] },
        { buildingId: 'b1', propertyType: 'BUILDING', units: [] },
      ],
      byBuilding,
    );

    expect(cards[0]?.occupiedUnits).toEqual(held);
    expect(cards[1]?.occupiedUnits).toBeUndefined();
    expect(cards.flatMap((card) => card.occupiedUnits ?? [])).toHaveLength(2);
  });

  it('spends the list on the card that can use it, not the first one linked', () => {
    /*
      A card that itemises its own flats is answered from those rows and never
      from the occupancies. Letting it consume the list anyway would leave the
      card that *does* need it with nothing — and a resident silently unbilled
      is worse than the double this rule exists to prevent.
    */
    const cards = attachOccupancies(
      [
        { buildingId: 'b1', propertyType: 'BUILDING', units: [{}, {}] },
        { buildingId: 'b1', propertyType: 'BUILDING', units: [] },
      ],
      byBuilding,
    );

    expect(cards[0]?.occupiedUnits).toBeUndefined();
    expect(cards[1]?.occupiedUnits).toEqual(held);
  });

  it('withholds the list when a منزل card is on the same building', () => {
    /*
      A منزل bills its single unit from its own card fields, and the census's
      single-unit inference has recorded an occupancy on that very flat. Handing
      the list to the مبنى card beside it would bill the same flat twice.
    */
    const cards = attachOccupancies(
      [
        { buildingId: 'b1', propertyType: 'HOUSE', units: [] },
        { buildingId: 'b1', propertyType: 'BUILDING', units: [] },
      ],
      byBuilding,
    );

    expect(cards[0]?.occupiedUnits).toBeUndefined();
    expect(cards[1]?.occupiedUnits).toBeUndefined();
  });

  it('keeps two buildings apart', () => {
    // Flats held in one block must never be counted against a card on another.
    const cards = attachOccupancies(
      [
        { buildingId: 'b1', propertyType: 'BUILDING', units: [] },
        { buildingId: 'b2', propertyType: 'BUILDING', units: [] },
      ],
      new Map([
        ['b1', [{ role: 'OWNER' }]],
        ['b2', [{ role: 'TENANT' }, { role: 'TENANT' }]],
      ]),
    );

    expect(cards[0]?.occupiedUnits).toHaveLength(1);
    expect(cards[1]?.occupiedUnits).toHaveLength(2);
  });

  it('leaves an unlinked card alone', () => {
    // No building means no flats to hold in one — أرض and خيمة never link.
    const [card] = attachOccupancies([{ propertyType: 'LAND', units: [] }], byBuilding);
    expect(card?.occupiedUnits).toBeUndefined();
  });
});
