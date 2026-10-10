import { billedBareCards, type ProfileBillingCard } from './reporting.service';

/**
 * Which cards the file shows «معفاة» and the owners' split on — the cards
 * `holdingsOf` bills through the census (the review of PR #101, F8).
 */

let seq = 0;
const card = (over: Partial<ProfileBillingCard> = {}): ProfileBillingCard => ({
  id: `card-${(seq += 1)}`,
  endedAt: null,
  propertyType: 'BUILDING',
  buildingId: 'b-1',
  units: [],
  ...over,
});
const ids = (cards: readonly ProfileBillingCard[]) => cards.map((entry) => entry.id);

describe('billedBareCards', () => {
  it('reads the latest registration only, as billing does', () => {
    const latest = card();
    const older = card();
    expect(ids(billedBareCards([{ properties: [latest] }, { properties: [older] }]).blocks)).toEqual([latest.id]);
  });

  it('counts a line only while it is current — a card whose every line has ended is bare', () => {
    const ended = card({ units: [{ endedAt: new Date('2026-07-01T00:00:00Z') }] });
    const current = card({ buildingId: 'b-2', units: [{ endedAt: null }] });
    expect(ids(billedBareCards([{ properties: [ended, current] }]).blocks)).toEqual([ended.id]);
  });

  it('leaves out ended cards', () => {
    expect(billedBareCards([{ properties: [card({ endedAt: new Date('2026-07-01T00:00:00Z') })] }])).toEqual({
      houses: [],
      blocks: [],
    });
  });

  it('gives a building’s flats to its first مبنى card only', () => {
    const first = card();
    const second = card();
    expect(ids(billedBareCards([{ properties: [first, second] }]).blocks)).toEqual([first.id]);
  });

  it('lets any other card on the building suppress the مبنى card, not only a bare منزل', () => {
    const house = card({ propertyType: 'HOUSE', units: [{ endedAt: null }] });
    const block = card();
    const result = billedBareCards([{ properties: [house, block] }]);
    expect(result.blocks).toEqual([]);
    // A منزل with a current line of its own bills that line, not the building's one flat.
    expect(result.houses).toEqual([]);
  });

  it('bills a bare منزل through its building', () => {
    const house = card({ propertyType: 'HOUSE' });
    expect(ids(billedBareCards([{ properties: [house] }]).houses)).toEqual([house.id]);
  });
});
