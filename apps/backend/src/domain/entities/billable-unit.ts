/**
 * What a fee can actually be charged against.
 *
 * A citizen's holdings are stored in two shapes, for good reasons that have
 * nothing to do with billing. A مبنى keeps its flats in `building_units`,
 * because a building *is* a list of units and each one has its own floor and
 * area. A منزل, an أرض or a خيمة keeps its single unit flat on the property
 * card itself, because inventing a one-row child table for a plot of land
 * would be ceremony around nothing.
 *
 * Assessment cannot care about that difference. "Six shops" has to mean six
 * whether they are six units in one building, six cards on six parcels, or —
 * now that a parcel may carry several structures — six cards on one. This is
 * the one place that flattening happens, so no rate rule has to know how the
 * register chose to store what it is charging for.
 */

/**
 * Unit types that describe a floor rather than premises — «طابق أعمدة» and
 * «طابق فارغ». Nobody occupies one and nobody is billed for one.
 *
 * Restated here rather than imported, because this layer imports nothing
 * outside itself. That is exactly how `UnitType` in `property-entry.entity.ts`
 * fell three values behind the schema — so `structural-unit.spec.ts` asserts
 * this set equals `STRUCTURAL_UNIT_TYPE` in the shared enums, and the next
 * structural type added will fail that test instead of arriving on a bill.
 */
const STRUCTURAL_UNIT_TYPES: ReadonlySet<string> = new Set(['PILOTIS', 'EMPTY_FLOOR']);

/** The taxonomy values a card may hold; kept loose to avoid importing Prisma enums. */
export interface BillableUnit {
  /** `APARTMENT`, `SHOP`, … or null where the card never recorded one. */
  unitType: string | null;
  /** Square metres, or null when it was never established. */
  unitArea: number | null;
  /**
   * `VACANT`, `RENTED`, … or null where nobody was asked.
   *
   * Carried through the flattening rather than read from the card later,
   * because after this function there is no card — a shop is a shop whether it
   * came from a building's unit row or from a منزل filed on its own parcel,
   * and an exemption that could only see one of those two shapes would exempt
   * a landlord's empty flat and charge the identical empty house next door.
   */
  unitStatus: string | null;
  /**
   * `OWNER`, `TENANT` or `FREE_OCCUPANT` — the filer's relationship to the
   * card this unit came from.
   *
   * Carried alongside the status because neither answers "should this person
   * be billed for this unit" alone. A flat marked مؤجرة means "someone else
   * lives here" on an owner's card and cannot appear on anyone else's; a null
   * status means "not asked" on an owner's card and "not applicable" on a
   * tenant's. The bearer rule needs both facts in the same hand — see
   * `bearsFee`.
   */
  occupancyType: string;
  /** The card this came from, for the invoice's breakdown. */
  propertyType: string;
  propertyNumber: string | null;
}

/**
 * The canonical unit a card's line has been linked to, when one exists.
 *
 * This is the P2-T8 authority flip, and it is deliberately narrow. The
 * municipality's own `Unit` row is the better record of a flat — it survives
 * the card being edited, it is what a field officer corrects from the matrix,
 * and it is what two cards describing the same flat both point at. So where the
 * link exists, it wins.
 *
 * Where it does not, the card wins, and that is not a transitional wart: a
 * منزل, an أرض and a خيمة never get a `Unit`, and neither does a building on a
 * parcel nobody has surveyed yet. A biller that could only read the new tables
 * would stop charging for most of the register.
 */
export interface LinkedUnit {
  unitType: string | null;
  unitArea: { toString(): string } | number | null;
  unitStatus?: string | null;
}

/** The stored shape this reads — a property card and its unit rows. */
export interface BillablePropertyEntry {
  propertyType: string;
  propertyNumber: string | null;
  occupancyType: string;
  unitType: string | null;
  /** Prisma hands Decimal back; a plain number or null is equally acceptable. */
  unitArea: { toString(): string } | number | null;
  unitStatus?: string | null;
  /**
   * `unitType` is nullable here for the same reason `unitArea` always was: a
   * per-unit «غير مؤكَّد» flag blanks the field it excuses (migration 0031), so
   * a surveyed building can legitimately contain a flat whose type nobody
   * established. It matches no `targetCategory`, which is the correct
   * behaviour — a notice aimed at محلات cannot charge a unit nobody has
   * identified as one — and it still counts under an uncategorised notice,
   * because it is a unit whether or not anyone wrote down what kind.
   *
   * `unit` is the canonical row this line was linked to, if it has been. See
   * `preferLinked` for which of the two each field is taken from, and why it is
   * per field rather than per row.
   */
  units: ReadonlyArray<{
    unitType: string | null;
    unitArea: { toString(): string } | number | null;
    unitStatus?: string | null;
    unit?: LinkedUnit | null;
  }>;
  /**
   * This citizen's current occupancies on units of the building this card is
   * linked to — read from `UnitOccupancy`, and consulted only when the card
   * itemises no units of its own.
   *
   * It is what makes a مبنى card assessable when the census holds the matrix
   * and the card does not, without inferring anything from the building's own
   * unit count. See `heldThroughOccupancy`, which is the only reader.
   */
  occupiedUnits?: ReadonlyArray<{
    /** `OWNER`, `TENANT` or `FREE_OCCUPANT` — this citizen's capacity in this flat. */
    role: string;
    unitType: string | null;
    unitArea: { toString(): string } | number | null;
    unitStatus?: string | null;
  }>;
}

function toNumber(value: { toString(): string } | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether this card is a building nobody has been inside.
 *
 * A مبنى with no unit rows is not a building with nothing in it — it is a
 * building whose units were never surveyed, which is a state the register
 * explicitly supports: an officer who could not get past the caretaker flags
 * «الوحدات غير مجرودة» and files the record anyway.
 *
 * It has to be told apart from a genuine zero, because under a per-unit rate
 * the two produce the same number and opposite meanings. Counted as zero, the
 * largest unsurveyed building in the municipality bills nothing at all — and
 * the fee schedule would be quietly most generous to exactly the properties
 * worth the most. See `assessCitizen`, which refuses to guess.
 *
 * There is one case where a card with no unit rows is nonetheless assessable,
 * and it is what `heldThroughOccupancy` answers — see below.
 */
export function isUnsurveyed(entry: BillablePropertyEntry): boolean {
  if (entry.propertyType !== 'BUILDING' || entry.units.length > 0) return false;
  return heldThroughOccupancy(entry) === null;
}

/**
 * The flats this citizen holds in a building their card does not itemise.
 *
 * This is the question P2-T8 left open, answered. A مبنى card with no unit rows
 * used to be unassessable full stop — "nobody has been inside". Once the census
 * exists that is no longer the only reading: an officer who filled the matrix
 * from the map has surveyed the building, and this citizen's card was simply
 * never updated to list their flats.
 *
 * The tempting shortcut was to bill such a card because the *building* has
 * units. That is wrong and was reverted: what an assessment needs is not "does
 * this building have units" but "**which** of them does this citizen hold", and
 * a matrix of twelve flats says nothing about whether this person holds one or
 * all twelve. `UnitOccupancy` is the table that does say, because it is
 * per-citizen — so it is what this reads, and nothing is inferred from the
 * building's own count.
 *
 * Returns null rather than an empty array when there is nothing to go on, so
 * `isUnsurveyed` can tell "this citizen holds no recorded flats here" (which
 * still stops the assessment, correctly — the building may be unsurveyed) from
 * "here is what they hold".
 *
 * **The role comes from the occupancy row, and only here.** Everywhere else it
 * comes from the card, because a card's own unit rows carry no role of their
 * own — see `billableUnits`. These rows do: each one names this citizen and
 * their capacity in that specific flat, which is exactly the fact the join
 * table was created to hold (D2). An owner abroad and the tenant living in
 * their flat are two rows on one unit, and selecting by citizen picks the right
 * one without anything having to guess.
 */
function heldThroughOccupancy(entry: BillablePropertyEntry): BillableUnit[] | null {
  if (entry.propertyType !== 'BUILDING' || entry.units.length > 0) return null;

  const held = entry.occupiedUnits ?? [];
  if (held.length === 0) return null;

  return held.map((occupancy) => ({
    unitType: occupancy.unitType,
    unitArea: toNumber(occupancy.unitArea),
    unitStatus: occupancy.unitStatus ?? null,
    occupancyType: occupancy.role,
    propertyType: entry.propertyType,
    propertyNumber: entry.propertyNumber,
  }));
}

/**
 * The canonical unit's value where there is one, the card's where there is not
 * — field by field, not row by row.
 *
 * Per field because the two rows are not rivals telling the same story at
 * different times; they are two partial records of one flat. The `Unit` is the
 * municipality's own and is corrected from the matrix, so it wins wherever it
 * has an answer. But a card can carry a مساحة for a flat whose canonical row
 * has none — the officer who linked them measured it and the one who generated
 * the matrix did not — and taking the whole row would throw that away and make
 * the citizen unassessable under a PER_AREA notice.
 *
 * Nothing here invents a value. Where both are null the result is null, which
 * is what the two guards in `assessCitizen` are for.
 */
function preferLinked(line: {
  unitType: string | null;
  unitArea: { toString(): string } | number | null;
  unitStatus?: string | null;
  unit?: LinkedUnit | null;
}): { unitType: string | null; unitArea: number | null; unitStatus: string | null } {
  return {
    unitType: line.unit?.unitType ?? line.unitType,
    unitArea: toNumber(line.unit?.unitArea ?? null) ?? toNumber(line.unitArea),
    unitStatus: line.unit?.unitStatus ?? line.unitStatus ?? null,
  };
}

/**
 * Every chargeable unit on one property card, in either storage shape.
 *
 * Structural rows are removed here, once, rather than at each place a fee is
 * decided. A طابق أعمدة or a طابق فارغ is a floor the matrix has to draw, not a
 * flat: it has no occupant, no area anyone lives in, and nobody to bill.
 *
 * This is the predicate that actually closes it, and it has to be here rather
 * than beside the two occupancy guards, because the guards protect
 * `unit_occupancies` and billing does not read that table. It reads the card's
 * `building_units` link — and `preferLinked` takes the *census* unit's type in
 * preference to the card's, so a card that says APARTMENT while pointing at a
 * pilotis arrives in assessment as a pilotis. Nothing downstream would catch
 * it: `unitMatches` opens with `if (!category) return true`, so any
 * ALL_CITIZENS or single-citizen notice charges for it.
 *
 * Keeping the structural types out of `FEE_TARGET_CATEGORY` stops a fee being
 * *aimed* at them. Only this stops one being charged *for* them.
 */
export function billableUnits(entry: BillablePropertyEntry): BillableUnit[] {
  // Filtered after the fact, not inside each branch, so a future third storage
  // shape cannot reintroduce the hole by forgetting to ask.
  return collectBillableUnits(entry).filter(
    (unit) => unit.unitType === null || !STRUCTURAL_UNIT_TYPES.has(unit.unitType),
  );
}

/** Whether a type describes a floor rather than premises. Exported for the drift guard. */
export function isStructuralBillableType(type: string | null | undefined): boolean {
  return type != null && STRUCTURAL_UNIT_TYPES.has(type);
}

function collectBillableUnits(entry: BillablePropertyEntry): BillableUnit[] {
  if (entry.units.length > 0) {
    return entry.units.map((line) => ({
      ...preferLinked(line),
      // Occupancy is recorded on the card, never on the unit row: a citizen is
      // the owner of a whole building or the tenant of one flat in it, and
      // there is no shape in which one card mixes the two.
      //
      // Deliberately *not* taken from `UnitOccupancy`, even now that it exists.
      // That table records every party to a flat at once — an owner abroad and
      // the tenant living in it are two rows on one unit, which is the whole
      // reason it is a join table (D2). Reading a role from it here would need
      // this function to already know which of those two people is being
      // billed, and the answer is on the card it came from.
      occupancyType: entry.occupancyType,
      propertyType: entry.propertyType,
      propertyNumber: entry.propertyNumber,
    }));
  }

  /*
    The card itemises nothing, but the census knows what this citizen holds
    here. Their occupancies are the answer, and each one carries its own role.
  */
  const held = heldThroughOccupancy(entry);
  if (held) return held;

  // A building with no rows is unsurveyed, not empty — and must not be handed
  // back as a phantom unit that a rate would happily multiply by.
  if (isUnsurveyed(entry)) return [];

  return [
    {
      unitType: entry.unitType,
      unitArea: toNumber(entry.unitArea),
      unitStatus: entry.unitStatus ?? null,
      occupancyType: entry.occupancyType,
      propertyType: entry.propertyType,
      propertyNumber: entry.propertyNumber,
    },
  ];
}
