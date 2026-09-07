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
 */
export type UnitType =
  | 'APARTMENT'
  | 'INDEPENDENT_HOUSE'
  | 'CLINIC'
  | 'OFFICE'
  | 'SHOP'
  | 'WAREHOUSE';
export type LandType = 'AGRICULTURAL' | 'INDUSTRIAL';
/** حالة الوحدة — about the unit. See `UNIT_STATUS` in the shared enums. */
export type UnitStatus = 'OWNER_OCCUPIED' | 'RENTED' | 'VACANT' | 'UNDER_CONSTRUCTION';

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
  unitArea: number;
  sharedRights?: string[];
  /** Owner cards only; `normalise` clears it on anyone else's. */
  unitStatus?: UnitStatus | null;
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

    // Common to every type, checked once here rather than duplicated in each
    // branch below.
    if (!required('neighborhood', Boolean(props.neighborhood?.trim()))) {
      throw fail('Every property requires a neighbourhood');
    }

    // Only a building is divisible into units; anything else with a `units`
    // array is a caller that has confused the two shapes. Not waivable: this
    // is a contradiction in the payload rather than a fact nobody could collect.
    if (props.propertyType !== 'BUILDING' && (props.units?.length ?? 0) > 0) {
      throw fail(`A ${props.propertyType.toLowerCase()} cannot be divided into units`);
    }

    switch (props.propertyType) {
      case 'BUILDING': {
        if (!required('buildingName', Boolean(props.buildingName?.trim()))) {
          throw fail('A building requires a building name');
        }

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
        if (!required('buildingName', Boolean(props.buildingName?.trim()))) {
          throw fail('A house requires a name or description');
        }
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
        if (!required('shares', Boolean(props.shares && props.shares > 0))) {
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
      buildingName: hasStructure ? (props.buildingName?.trim() ?? null) : null,
      floor: null,
      side: props.propertyType === 'HOUSE' ? (props.side?.trim() ?? null) : null,
      tentLocation: props.propertyType === 'TENT' ? (props.tentLocation?.trim() ?? null) : null,
      unitArea:
        props.propertyType === 'TENT' || isBuilding ? null : (props.unitArea ?? null),
      shares: props.propertyType === 'LAND' ? (props.shares ?? null) : null,
      sharedRights: props.propertyType === 'HOUSE' ? (props.sharedRights ?? []) : [],
      // A منزل is the only card that describes its own single unit; a مبنى
      // states this per unit below, and أرض and خيمة are never asked.
      unitStatus:
        isOwner && props.propertyType === 'HOUSE' ? (props.unitStatus ?? null) : null,
      units: isBuilding
        ? (props.units ?? []).map((unit) => ({
            ...unit,
            floor: unit.floor.trim(),
            side: unit.side?.trim() || null,
            sharedRights: unit.sharedRights ?? [],
            unitStatus: isOwner ? (unit.unitStatus ?? null) : null,
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
