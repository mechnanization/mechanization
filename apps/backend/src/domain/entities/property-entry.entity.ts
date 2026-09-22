import { ValidationError } from '../errors/domain-error';

export type OccupancyType = 'OWNER' | 'TENANT' | 'FREE_OCCUPANT';
export type PropertyType = 'BUILDING' | 'HOUSE' | 'LAND' | 'TENT';
/**
 * Kept in step with `UNIT_TYPE` in the shared enums by hand, because this layer
 * deliberately imports nothing.
 *
 * It had fallen three values behind — `INDEPENDENT_HOUSE`, `OFFICE` and
 * `WAREHOUSE` were added to the schema and the database when fees became
 * per-unit, and never here. Nothing failed to compile, because every write
 * crosses into Prisma through an `as never`, so the drift was invisible until
 * a rate schedule tried to charge a مستودع differently from a محل.
 *
 * It then fell three behind again — `GARAGE`, and the two structural floor
 * types — for exactly the same reason, and `UnitStatus` below was two behind.
 * Writing "kept in step by hand" at the top of a list did not keep it in step.
 * `domain-enum-drift.spec.ts` now asserts both against the shared enums, so
 * the next value added fails a test rather than a rate schedule.
 */
export type UnitType =
  | 'APARTMENT'
  | 'INDEPENDENT_HOUSE'
  | 'CLINIC'
  | 'OFFICE'
  | 'SHOP'
  | 'WAREHOUSE'
  | 'GARAGE'
  // Structural: a floor the matrix draws, never premises. Not occupiable and
  // not billable — see `billableUnits`, which drops them before assessment.
  | 'PILOTIS'
  | 'EMPTY_FLOOR';
export type LandType = 'AGRICULTURAL' | 'INDUSTRIAL';
/**
 * حالة الوحدة — about the unit. See `UNIT_STATUS` in the shared enums.
 *
 * `FREE_OCCUPIED` («مشغولة بتسامح») is the value whose absence let an owner and
 * a شاغل بتسامح both be billed for one flat; `SEASONAL` («مسكن موسمي») arrived
 * with migration 0040. Both were in the database and the shared enums long
 * before they were here.
 */
export type UnitStatus =
  | 'OWNER_OCCUPIED'
  | 'RENTED'
  | 'FREE_OCCUPIED'
  | 'SEASONAL'
  | 'VACANT'
  | 'UNDER_CONSTRUCTION';

/** Occupancies that describe someone living in a property they do not own. */
const NON_OWNER: ReadonlySet<OccupancyType> = new Set(['TENANT', 'FREE_OCCUPANT']);

/**
 * One unit inside a building. A citizen who owns the whole building files a
 * single عقار carrying several of these — the parcel has one رقم العقار, and
 * that number is unique, so the units cannot each be their own entry.
 */
export interface BuildingUnitProps {
  unitType: UnitType;
  floor: string;
  side?: string | null;
  /**
   * م² — required of a card being *created* and nullable on one being read back.
   *
   * `assertTaxonomyConsistent` still refuses a submitted unit without one, so
   * nothing a citizen or an officer fills in reaches storage unmeasured. What
   * is nullable is the column behind it (migration 0031), and two paths
   * legitimately leave it empty: a field flag recording that the area could not
   * be established, and `claimOnFile`, which copies the canonical `Unit`'s area
   * onto a freshly minted card line and finds none for a flat that was painted
   * on the matrix and never measured.
   *
   * Typed `number | null` so `rehydrate` can carry that absence honestly. It
   * used to be `number`, which forced every reader to coerce — and `Number(null)`
   * is `0`, so an unmeasured flat came back claiming a measurement of zero.
   */
  unitArea: number | null;
  sharedRights?: string[];
  /** Owner cards only; `normalise` clears it on anyone else's. */
  unitStatus?: UnitStatus | null;
  /**
   * The canonical `Unit` this line describes, when the officer picked one.
   * Where set, the `Unit` outranks this row field by field — see P2-T8.
   */
  unitId?: string | null;
}

export interface PropertyEntryProps {
  occupancyType: OccupancyType;
  landlordName?: string | null;
  landlordPhone?: string | null;
  propertyType: PropertyType;
  /** الحي — common to every property type; free text, unlike رقم العقار there is nothing to check it against. */
  neighborhood?: string | null;
  propertyNumber?: string | null;
  unitType?: UnitType | null;
  landType?: LandType | null;
  buildingName?: string | null;
  floor?: string | null;
  side?: string | null;
  tentLocation?: string | null;
  unitArea?: number | null;
  /** LAND only — أسهم out of the cadastre's standard 2400-share parcel. */
  shares?: number | null;
  sharedRights?: string[];
  /**
   * HOUSE cards only, and only an owner's.
   *
   * A مبنى carries a status per unit inside `units`, because that is where its
   * units are. أرض and خيمة carry none at all: «is this plot of land vacant»
   * has no answer worth storing, and offering the field would put a fourth
   * question on every tent registration in a settlement.
   */
  unitStatus?: UnitStatus | null;
  /**
   * The censused structure this card is about, when one was picked.
   *
   * BUILDING and HOUSE only, and `normalise` clears it on the other two: أرض
   * has nothing standing on it and a خيمة stays a bare card (Q2), so a link on
   * either would assert a structure the census does not model.
   */
  buildingId?: string | null;
  /** BUILDING only — every other type describes its single unit inline. */
  units?: BuildingUnitProps[];
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * The card's fields a field officer explicitly recorded as unestablished.
 *
 * Bare field names — `landlordPhone`, not `properties.2.landlordPhone` — because
 * by the time a card reaches this class it is one card, and it has no idea
 * which index it was. The caller strips the prefix; see
 * `RegistrationService.submit`.
 */
export type UnestablishedFields = ReadonlySet<string>;

const NOTHING_UNESTABLISHED: UnestablishedFields = new Set<string>();

/**
 * One property card. The taxonomy rules live here rather than only in Zod so
 * they hold for every entry point — HTTP, seed scripts, and the spreadsheet
 * import a municipality will inevitably ask for.
 */
export class PropertyEntry {
  private constructor(readonly props: Readonly<PropertyEntryProps>) {}

  /**
   * `unestablished` names the fields whose rule is waived for this card, and
   * nothing else about it changes.
   *
   * It is deliberately a *waiver list* rather than a "lenient mode": a card
   * filed with an empty set is validated exactly as it always was, and a card
   * that names `landlordPhone` still has every other rule applied to it in
   * full. That matters because these rules are the only ones that hold for the
   * seed script and the spreadsheet import, which never pass a set at all.
   */
  static create(
    props: PropertyEntryProps,
    unestablished: UnestablishedFields = NOTHING_UNESTABLISHED,
  ): PropertyEntry {
    PropertyEntry.assertOccupancyConsistent(props, unestablished);
    PropertyEntry.assertTaxonomyConsistent(props, unestablished);
    PropertyEntry.assertCoordinatesPlausible(props);
    return new PropertyEntry(PropertyEntry.normalise(props));
  }

  /** Rebuilds from a persisted row without re-running creation validation. */
  static rehydrate(props: PropertyEntryProps): PropertyEntry {
    return new PropertyEntry(props);
  }

  /**
   * Someone occupying a property they do not own has to name its owner.
   *
   * The *phone* is required of a tenant and not of a شاغل بتسامح, which is the
   * one place the two non-owner occupancies diverge. A tenant pays بدل to a
   * landlord every month and can reach them; a free occupant's owner is
   * routinely a relative abroad, elderly, or dead. Demanding a number there
   * does not produce one — it produces an invented number, or an «غير مؤكَّد»
   * flag on every such record until the flags stop carrying information.
   */
  private static assertOccupancyConsistent(
    props: PropertyEntryProps,
    unestablished: UnestablishedFields,
  ): void {
    if (!NON_OWNER.has(props.occupancyType)) return;

    if (!props.landlordName?.trim() && !unestablished.has('landlordName')) {
      throw new ValidationError('A non-owner entry requires the name of the property owner', {
        propertyNumber: props.propertyNumber ?? null,
      });
    }

    if (
      props.occupancyType === 'TENANT' &&
      !props.landlordPhone?.trim() &&
      !unestablished.has('landlordPhone')
    ) {
      throw new ValidationError('A tenant entry requires the landlord phone', {
        propertyNumber: props.propertyNumber ?? null,
      });
    }
  }

  private static assertTaxonomyConsistent(
    props: PropertyEntryProps,
    unestablished: UnestablishedFields,
  ): void {
    const fail = (message: string) =>
      new ValidationError(message, { propertyNumber: props.propertyNumber ?? null });

    /** A rule is checked unless the officer recorded that field as unestablished. */
    const required = (field: string, present: boolean) =>
      present || unestablished.has(field);

    /*
      الحي is no longer required, and is no longer asked for.

      It duplicated by hand what a parcel's zone already knows: `Zone.
      parcelNumbers` says which sector a عقار belongs to (D13), derived once and
      centrally rather than retyped per household with a different spelling
      every time. The field is still stored and still travels on the wire, so
      the values already collected are untouched and the forms can render it
      again the day it is fed by the zone instead of by a keyboard.

      Removed here as well as from `propertyEntrySchema`, because this entity is
      a second, independent gate: the schema stopped refusing a missing الحي and
      this invariant went on refusing it, which is a 422 no form could clear —
      the field it names is not on any form any more.
    */

    // Only a building is divisible into units; anything else with a `units`
    // array is a caller that has confused the two shapes. Not waivable: this
    // is a contradiction in the payload rather than a fact nobody could collect.
    if (props.propertyType !== 'BUILDING' && (props.units?.length ?? 0) > 0) {
      throw fail(`A ${props.propertyType.toLowerCase()} cannot be divided into units`);
    }

    switch (props.propertyType) {
      case 'BUILDING': {
        /*
          «اسم المبنى» is not required, of either structure branch.

          It was, and the demand produced values that named no building: most
          blocks here are unnamed, and a required field in front of an officer
          who came to record a household is answered with «بناية», or the
          street, or the owner's surname — differently each time, which is
          precisely why `Building.name` on the census outranks this column
          wherever a card is linked to a structure.

          Nothing identifies a card by it. رقم العقار is still required, and a
          linked card additionally carries the building's derived code (D9).
          See `buildingNameField` in `property.schema.ts`, which is the other
          half of this rule — the two have to agree, or a card the form accepts
          is one the entity throws on.
        */

        // The units carry نوع الوحدة / الطابق / المساحة now, so a building with
        // none of them describes nothing at all — unless the officer has said
        // as much, which is what a flag on `units` records.
        const units = props.units ?? [];
        if (units.length === 0) {
          if (!unestablished.has('units')) throw fail('A building requires at least one unit');
          break;
        }

        // A unit that *was* entered is entered whole. The flag is offered on the
        // collection, not inside it: "we could not go through the building" is a
        // thing that happens, "we recorded this apartment but not its floor" is
        // an unfinished form.
        units.forEach((unit, index) => {
          const where = `unit ${index + 1}`;
          if (!unit.unitType) throw fail(`${where} requires a unit type`);
          if (!unit.floor?.trim()) throw fail(`${where} requires a floor`);
          if (!unit.unitArea || unit.unitArea <= 0) throw fail(`${where} requires an area`);
        });
        break;
      }
      case 'HOUSE':
        // No name demanded here either — see the BUILDING branch above.
        if (!required('unitArea', Boolean(props.unitArea && props.unitArea > 0))) {
          throw fail('A house requires an area');
        }
        if (props.floor) throw fail('A standalone house cannot have a floor');
        /*
          A منزل has exactly one unit type and `normalise` supplies it.
          
          The rule used to be "a standalone house cannot have a unit type at
          all", which is what made `INDEPENDENT_HOUSE` unreachable: the value
          existed in the enum, in the database and in the list of things a fee
          may target, and nothing could ever produce a row carrying it. What is
          still refused is a *different* type on a house — a منزل is not a
          مستودع, and a card claiming so has confused the two shapes.
        */
        if (props.unitType && props.unitType !== 'INDEPENDENT_HOUSE') {
          throw fail('A standalone house can only be an independent house');
        }
        break;
      case 'LAND':
        if (!required('landType', Boolean(props.landType))) throw fail('Land requires a land type');
        if (!required('unitArea', Boolean(props.unitArea && props.unitArea > 0))) {
          throw fail('Land requires an area');
        }
        // أسهم are a share of ownership: asked of the owner, never of a tenant
        // or a شاغل بتسامح farming the plot (see `ownerLandShares`).
        if (
          props.occupancyType === 'OWNER' &&
          !required('shares', Boolean(props.shares && props.shares > 0))
        ) {
          throw fail('Land requires a share count');
        }
        if (props.floor || props.unitType || props.buildingName) {
          throw fail('Land cannot carry building details');
        }
        break;
      case 'TENT':
        if (!required('tentLocation', Boolean(props.tentLocation?.trim()))) {
          throw fail('A tent requires a location description');
        }
        if (props.floor || props.unitType || props.buildingName) {
          throw fail('A tent cannot carry building details');
        }
        break;
    }
  }

  /**
   * A pin dropped outside Lebanon is a mis-tap or a spoofed payload, and it
   * would silently distort the admin map's bounds for every other entry.
   */
  private static assertCoordinatesPlausible(props: PropertyEntryProps): void {
    const { latitude, longitude } = props;
    if (latitude == null && longitude == null) return;

    if (latitude == null || longitude == null) {
      throw new ValidationError('A location needs both a latitude and a longitude', {
        propertyNumber: props.propertyNumber ?? null,
      });
    }
    if (latitude < 33.0 || latitude > 34.7 || longitude < 35.0 || longitude > 36.7) {
      throw new ValidationError('الموقع خارج حدود لبنان', {
        propertyNumber: props.propertyNumber ?? null,
      });
    }
  }

  /** Strips fields that do not belong to the chosen branch. */
  private static normalise(props: PropertyEntryProps): PropertyEntryProps {
    const isBuilding = props.propertyType === 'BUILDING';
    const hasStructure = isBuilding || props.propertyType === 'HOUSE';
    const isNonOwner = NON_OWNER.has(props.occupancyType);

    /*
      حالة الوحدة is the owner's statement and nobody else's.

      Stripped rather than rejected, matching how the landlord block is handled
      one line down: an out-of-branch value is what a card that was edited looks
      like — occupancy switched from مالك to مستأجر with the old status still
      sitting in the payload — and refusing the save over a leftover would fail
      a correction the clerk got right. What must not survive is the leftover
      itself: a «شاغرة» carried onto a tenant's card would claim that the person
      filing it does not live there, and could exempt them from a fee they owe.
    */
    const isOwner = props.occupancyType === 'OWNER';

    return {
      ...props,
      neighborhood: props.neighborhood?.trim() || null,
      landlordName: isNonOwner ? (props.landlordName?.trim() || null) : null,
      /*
        `|| null` rather than a bare optional chain, because this is now a field
        that can legitimately be absent on a card that is otherwise complete.
        A tenant's landlord phone is required, so `undefined` never reached
        here before; a free occupant's is not, and leaving it undefined makes
        the entity disagree with the nullable column it is written to — and
        with every reader that checks for null.
      */
      landlordPhone: isNonOwner ? (props.landlordPhone?.trim() || null) : null,
      /*
        A building's unit detail lives in `units`; the inline columns describe
        the single unit that a HOUSE or a LAND is, and stay empty for a building.

        A منزل is the one card whose own unit has a type, and it is *derived*
        rather than asked: a standalone dwelling is an `INDEPENDENT_HOUSE` and
        there is nothing else it could be, so putting the question on the form
        would be a dropdown with one answer. Deriving it here is what makes the
        value reachable at all — `billableUnits` reads it, `unitMatches` matches
        on it, and a fee aimed at «منازل مستقلة» found nothing whatsoever while
        this was hardcoded to null for every card.

        أرض and خيمة genuinely have no unit type; they are not dwellings, and
        `UNIT_TYPE` has no value that would describe them.
      */
      unitType: props.propertyType === 'HOUSE' ? 'INDEPENDENT_HOUSE' : null,
      landType: props.propertyType === 'LAND' ? (props.landType ?? null) : null,
      /*
        `|| null` rather than `?? null`, for the reason `landlordPhone` above
        gives: now that a name is optional, an empty string is a shape a
        complete card legitimately arrives in, and storing `''` would make
        "unnamed" two different values in the column. Every reader already
        tests it with `?.trim()` — `CensusSyncService.nameBuildings` is the one
        that matters, since it promotes a card's name onto the census building
        — so a stray `''` would not be *read* as a name; it would simply be a
        second way of saying nothing, and only one of the two is greppable.
      */
      buildingName: hasStructure ? (props.buildingName?.trim() || null) : null,
      floor: null,
      side: props.propertyType === 'HOUSE' ? (props.side?.trim() ?? null) : null,
      tentLocation: props.propertyType === 'TENT' ? (props.tentLocation?.trim() ?? null) : null,
      unitArea:
        props.propertyType === 'TENT' || isBuilding ? null : (props.unitArea ?? null),
      shares: props.propertyType === 'LAND' && isOwner ? (props.shares ?? null) : null,
      sharedRights: props.propertyType === 'HOUSE' ? (props.sharedRights ?? []) : [],
      // A منزل and an أرض describe their own single unit; a مبنى states this
      // per unit below, and a خيمة is never asked. An owner's plot says whether
      // somebody else works it — without that, a rented plot was billed to its
      // owner and to its tenant under an occupant-borne notice.
      unitStatus:
        isOwner && (props.propertyType === 'HOUSE' || props.propertyType === 'LAND')
          ? (props.unitStatus ?? null)
          : null,
      // A link to a structure, on the two types that can stand on one.
      buildingId:
        props.propertyType === 'BUILDING' || props.propertyType === 'HOUSE'
          ? (props.buildingId ?? null)
          : null,
      units: isBuilding
        ? (props.units ?? []).map((unit) => ({
            ...unit,
            floor: unit.floor.trim(),
            side: unit.side?.trim() || null,
            sharedRights: unit.sharedRights ?? [],
            unitStatus: isOwner ? (unit.unitStatus ?? null) : null,
            unitId: unit.unitId ?? null,
          }))
        : [],
      propertyNumber: props.propertyNumber?.trim() || null,
    };
  }

  /** Null when the officer could not establish رقم العقار — see `UnestablishedFields`. */
  get propertyNumber(): string | null {
    return this.props.propertyNumber ?? null;
  }

  get propertyType(): PropertyType {
    return this.props.propertyType;
  }

  /**
   * Which proof a citizen must attach for this specific card.
   *
   * Null for a شاغل بتسامح, and that is the honest answer rather than a gap:
   * the arrangement has no document. There is no عقد إيجار because no بدل is
   * paid, and the سند الملكية names the owner, who is not the person filing.
   * Asking for either would mean asking for a paper that does not exist — so
   * the card is complete without one, and §7's "required proof follows
   * occupancy" gains its third case.
   */
  get requiredProofDocument(): 'OWNERSHIP_PROOF' | 'RENTAL_CONTRACT' | null {
    if (this.props.occupancyType === 'TENANT') return 'RENTAL_CONTRACT';
    return this.props.occupancyType === 'OWNER' ? 'OWNERSHIP_PROOF' : null;
  }
}
