/**
 * Which property card, if any, already claims a flat the census records.
 *
 * The other half of `billableUnits`. That function answers "what does this card
 * charge for"; this one answers "does this card already charge for *that* flat"
 * — and the two have to agree, because a flat no card claims goes unbilled and
 * a flat two cards claim is billed twice.
 *
 * ## The three shapes a claim comes in
 *
 * A card names the flat with a `building_units` row. That is the explicit
 * shape, and the only one that needs no inference.
 *
 * A **مبنى card with no rows** claims every flat this citizen holds in the
 * structure — `heldThroughOccupancy` bills it that way, so the claim and the
 * bill are the same statement.
 *
 * A **منزل card** (or any card that is not a مبنى) has no rows to name a flat
 * with: it bills from its own columns, one flat's worth. Which flat that is has
 * to be inferred, and the inference used to be the structure's unit count —
 * "the building has exactly one unit, so this card is about it".
 *
 * ## Why the unit count was the wrong thing to infer from
 *
 * It stops being true the moment an officer adds a second unit. Production
 * 2026-09-19, Z-5-201-A: a منزل card for a 130 m² home, filed while the
 * structure was a single house; the officer then made it a three-floor
 * building, added a 9 m² مستودع and recorded the same man as its owner. The
 * card claimed nothing under the old rule, so the tick appended the مستودع as
 * its first row — and `billableUnits` reads a card's rows whenever it has any
 * and its own columns only while it has none. From that moment the
 * municipality assessed 9 m² and his home was not assessed at all.
 *
 * So the inference is made against the register's own record of what this
 * citizen holds — `UnitOccupancy`, the same table `heldThroughOccupancy` reads
 * — and against nothing about the building.
 *
 * ## The rule, and why it counts rather than matches
 *
 * A column-billing card is about one flat, and there is nothing on it saying
 * which. So the flats are not matched to the cards; they are *counted* against
 * them. The flats this citizen holds here in a given capacity that no row
 * names are the flats those cards could be about. If there are at least as many
 * such cards as there are such flats, every flat is accounted for and this one
 * is already claimed. If the flats outnumber the cards, the surplus needs a
 * card of its own.
 *
 * On a single-unit structure that is the old inference unchanged — one flat,
 * one card. On one that has grown a second unit it is the difference between
 * re-recording a spell the card already covers (nothing to write) and a
 * genuinely second flat, which must not be turned into a row on a card that
 * would then stop billing the first.
 *
 * Counting rather than matching is what makes it safe on data this path did not
 * create: two منزل cards filed by hand on one structure account for two flats
 * between them, and neither is duplicated.
 *
 * ## What it deliberately does not decide
 *
 * Where the flats outnumber the cards, *none* of those flats is claimed — not
 * "all but the last". The cards carry nothing that says which flat each is
 * about, so picking one would be a guess, and a guess here bills the wrong
 * m². Recording any of the flats files it on a card that names it, which
 * removes it from the count, so the ambiguity resolves itself as the officer
 * works through the structure rather than being resolved by this function.
 */

/** A current card, as the claim rule reads it. Ended rows must be excluded by the caller. */
export interface ClaimingCard {
  propertyType: string;
  occupancyType: string;
  units: ReadonlyArray<{ unitId: string | null }>;
}

/** One of this citizen's current spells in the structure — `UnitOccupancy`, `toDate: null`. */
export interface CurrentSpell {
  unitId: string;
  /** `OWNER`, `TENANT` or `FREE_OCCUPANT`, compared against a card's نوع الإشغال. */
  role: string;
}

/**
 * Whether a card can take another flat as a row without losing what it bills.
 *
 * A card with no rows that is not a مبنى bills its own columns. Give it a row
 * and those columns stop being read, so the flat it was filed for silently
 * leaves the assessment — the Z-5-201-A defect above, produced by the tick
 * rather than by the card. Such a card is passed over; the flat gets a card of
 * its own and both are billed. A card that already carries rows is in the
 * itemised shape already and takes another.
 */
export function takesAnotherFlat(card: ClaimingCard): boolean {
  return card.propertyType === 'BUILDING' || card.units.length > 0;
}

/**
 * Whether each of these cards already claims `unitId`, given what the census
 * says this citizen holds in the structure.
 *
 * Returned as a predicate over the same array rather than a per-card call,
 * because the rule for a column-billing card is a count across all of them.
 */
export function claimsFlat(
  cards: readonly ClaimingCard[],
  spells: readonly CurrentSpell[],
  unitId: string,
): (card: ClaimingCard) => boolean {
  const namedByACard = new Set(
    cards.flatMap((card) => card.units.flatMap((row) => (row.unitId ? [row.unitId] : []))),
  );

  /** The other flats held here in this capacity that no row names. */
  const unaccounted = (capacity: string) =>
    spells.filter(
      (spell) =>
        spell.unitId !== unitId && spell.role === capacity && !namedByACard.has(spell.unitId),
    ).length;

  /** The cards in this capacity that bill from their own columns — one flat each. */
  const columnCards = (capacity: string) =>
    cards.filter(
      (card) =>
        card.occupancyType === capacity && card.propertyType !== 'BUILDING' && !card.units.length,
    ).length;

  return (card) =>
    card.units.some((row) => row.unitId === unitId) ||
    (card.propertyType === 'BUILDING' && card.units.length === 0) ||
    (card.propertyType !== 'BUILDING' &&
      card.units.length === 0 &&
      unaccounted(card.occupancyType) < columnCards(card.occupancyType));
}

/**
 * The card that claims this flat — one of the citizen's own capacity first.
 *
 * A second card claiming the same flat would bill it twice, so any capacity
 * counts; a flat sitting on a card of the wrong capacity is a correction for a
 * person to make, not one to paper over by filing it a second time.
 */
export function cardClaiming<T extends ClaimingCard>(
  cards: readonly T[],
  spells: readonly CurrentSpell[],
  unitId: string,
  capacity?: string,
): T | undefined {
  const claims = claimsFlat(cards, spells, unitId);
  return (
    (capacity === undefined
      ? undefined
      : cards.find((card) => card.occupancyType === capacity && claims(card))) ??
    cards.find(claims)
  );
}
