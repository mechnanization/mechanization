import { assessCitizen } from './fees.service';
import { billableUnits, isUnsurveyed } from '../../../domain/entities/billable-unit';
import type { BillablePropertyEntry } from '../../../domain/entities/billable-unit';

/**
 * Per-unit assessment — what a citizen actually owes, from what they hold.
 *
 * The register could always say a citizen holds six shops; the biller could
 * not read it and charged the same for six as for one. These pin down the
 * arithmetic and, more importantly, the two places it is allowed to refuse to
 * do arithmetic at all.
 */

const building = (
  propertyNumber: string,
  units: Array<[string, number | null] | [string, number | null, string]>,
  occupancyType = 'OWNER',
): BillablePropertyEntry => ({
  propertyType: 'BUILDING',
  propertyNumber,
  occupancyType,
  unitType: null,
  unitArea: null,
  units: units.map(([unitType, unitArea, unitStatus]) => ({
    unitType,
    unitArea,
    unitStatus: unitStatus ?? null,
  })),
});

const card = (
  propertyType: string,
  propertyNumber: string,
  unitType: string | null,
  unitArea: number | null,
  extra: { occupancyType?: string; unitStatus?: string } = {},
): BillablePropertyEntry => ({
  propertyType,
  propertyNumber,
  occupancyType: extra.occupancyType ?? 'OWNER',
  unitType,
  unitArea,
  unitStatus: extra.unitStatus ?? null,
  units: [],
});


/*
  A rented plot, under an occupant-borne notice reaching أرض.

  Land tenancies became fileable without an invented share count (and fileable
  at all for somebody living outside the town) on 2026-09-13. Before an owner's
  plot could say «مؤجرة», that owner and the farmer renting it were both
  charged for the one plot.
*/
describe('a rented plot is billed once', () => {
  // PER_UNIT: a FLAT notice charges everyone it targets whatever they hold, so
  // it cannot show which of the two parties to one plot owes for it.
  const rate = { basis: 'PER_UNIT' as const, amount: 100_000, bearer: 'OCCUPANT' as const, targetCategory: 'LAND' };

  it('does not bill the owner of a plot they have let', () => {
    const result = assessCitizen([card('LAND', '1553', null, 800, { unitStatus: 'RENTED' })], rate as never);
    expect(result.kind === 'assessed' && result.amount).toBe(0);
  });

  it('bills the farmer renting it', () => {
    const result = assessCitizen(
      [card('LAND', '1553', null, 800, { occupancyType: 'TENANT' })],
      rate as never,
    );
    expect(result.kind === 'assessed' && result.amount).toBe(100_000);
  });

  it('still bills an owner who works their own plot, or never said', () => {
    for (const unitStatus of ['OWNER_OCCUPIED', undefined]) {
      const result = assessCitizen([card('LAND', '1553', null, 800, { unitStatus })], rate as never);
      expect(result.kind === 'assessed' && result.amount).toBe(100_000);
    }
  });
});

/**
 * P2-T8 — the authority flip, against both linked and unlinked records.
 *
 * Until Phase 2, `PropertyEntry`/`BuildingUnit` were the only thing billing
 * read and the census tables were a read-model. Now the canonical `Unit` wins
 * *where it exists*, and the card wins where it does not — which is most of the
 * register and always will be: a منزل, an أرض and a خيمة never get a `Unit`,
 * and neither does a building on a parcel nobody has surveyed.
 *
 * Both halves are tested here, because a flip that only worked on linked rows
 * would silently stop charging for everything else.
 */
describe('billing authority — linked units win, unlinked cards still bill', () => {
  const linked = (
    line: [string | null, number | null, string | null],
    unit: { unitType?: string | null; unitArea?: number | null; unitStatus?: string | null } | null,
  ): BillablePropertyEntry => ({
    propertyType: 'BUILDING',
    propertyNumber: '1553',
    occupancyType: 'OWNER',
    unitType: null,
    unitArea: null,
    units: [
      {
        unitType: line[0],
        unitArea: line[1],
        unitStatus: line[2],
        unit: unit
          ? {
              unitType: unit.unitType ?? null,
              unitArea: unit.unitArea ?? null,
              unitStatus: unit.unitStatus ?? null,
            }
          : null,
      },
    ],
  });

  it('prefers the canonical unit’s values over the card’s', () => {
    // The card says the flat is 100m² and empty; the matrix — corrected by an
    // officer standing in it — says 140m² and rented. The municipality's own
    // row is the one that survives the card being edited.
    const units = billableUnits(
      linked(['APARTMENT', 100, 'VACANT'], { unitType: 'SHOP', unitArea: 140, unitStatus: 'RENTED' }),
    );

    expect(units).toEqual([
      expect.objectContaining({ unitType: 'SHOP', unitArea: 140, unitStatus: 'RENTED' }),
    ]);
  });

  it('falls back field by field, not row by row', () => {
    /*
      The case that makes per-field preference load-bearing.

      A generated matrix row has no area — nobody has measured it — while the
      card carries one from the officer who filed it. Taking the whole canonical
      row would throw that measurement away and make the citizen unassessable
      under a PER_AREA notice, over a number the register already has.
    */
    const units = billableUnits(
      linked(['APARTMENT', 120, null], { unitType: 'SHOP', unitArea: null }),
    );

    expect(units[0]).toEqual(
      expect.objectContaining({ unitType: 'SHOP', unitArea: 120 }),
    );
  });

  it('still reads the card when there is no canonical unit', () => {
    const units = billableUnits(linked(['APARTMENT', 120, 'RENTED'], null));

    expect(units[0]).toEqual(
      expect.objectContaining({ unitType: 'APARTMENT', unitArea: 120, unitStatus: 'RENTED' }),
    );
  });

  it('bills an unlinked منزل exactly as it always did', () => {
    // The half of the register that never gets a `Unit`. If the flip had made
    // the new tables mandatory this would bill nothing.
    const house = card('HOUSE', '1553', 'INDEPENDENT_HOUSE', 180);
    const outcome = assessCitizen([house], { amount: 1000, basis: 'PER_UNIT' });

    expect(outcome.kind).toBe('assessed');
    if (outcome.kind !== 'assessed') return;
    expect(outcome.amount).toBe(1000);
    expect(outcome.assessment.unitCount).toBe(1);
  });

  it('takes occupancy from the card, never from the unit', () => {
    /*
      `UnitOccupancy` records every party to a flat at once — an owner abroad
      and the tenant living in it are two rows on one unit, which is the whole
      reason it is a join table (D2). Reading a role from there would need this
      function to already know which of the two people is being billed, and the
      answer is on the card it came from.
    */
    const tenantCard: BillablePropertyEntry = {
      ...linked(['APARTMENT', 120, null], { unitType: 'APARTMENT', unitArea: 120 }),
      occupancyType: 'TENANT',
    };

    expect(billableUnits(tenantCard)[0]?.occupancyType).toBe('TENANT');
  });

  it('charges a linked shop under a محلات notice', () => {
    // The unit type that exists only on the canonical row still has to match a
    // category, or assessment and target-selection would disagree.
    const entry = linked([null, 40, null], { unitType: 'SHOP', unitArea: 40 });
    const outcome = assessCitizen([entry], {
      amount: 500,
      basis: 'PER_UNIT',
      targetCategory: 'SHOP',
    });

    expect(outcome.kind).toBe('assessed');
    if (outcome.kind !== 'assessed') return;
    expect(outcome.amount).toBe(500);
  });
});

describe('billing authority — a building the card does not itemise', () => {
  const emptyBuilding = (
    occupiedUnits?: Array<{
      role: string;
      unitType: string | null;
      unitArea: number | null;
      unitStatus?: string | null;
    }>,
  ): BillablePropertyEntry => ({
    propertyType: 'BUILDING',
    propertyNumber: '1553',
    occupancyType: 'OWNER',
    unitType: null,
    unitArea: null,
    units: [],
    ...(occupiedUnits ? { occupiedUnits } : {}),
  });

  it('still refuses to bill a building nobody has been inside', () => {
    // Unchanged, and the reason is unchanged: counted as zero, the largest
    // building in the municipality pays nothing and the schedule is most
    // generous to the properties worth the most.
    expect(isUnsurveyed(emptyBuilding())).toBe(true);

    const outcome = assessCitizen([emptyBuilding()], { amount: 1000, basis: 'PER_UNIT' });
    expect(outcome.kind).toBe('unassessable');
  });

  it('does not bill on the strength of the building having a matrix', () => {
    /*
      The relaxation that was written first and reverted, and it stays reverted.

      It is tempting: the card has no unit rows, but the census holds a matrix
      for its building, so the flats *are* known — why refuse? Because what an
      assessment needs is not "does this building have units", it is **which of
      them does this citizen hold**, and a matrix of twelve flats says nothing
      about whether this person holds one or twelve. Worse, `billableUnits` does
      not skip such a card — it emits one phantom unit from the card's own null
      fields, so a per-unit rate would bill an entire block as a single flat.

      An empty occupancy list is exactly that case: the census may know the
      building well and know nothing about this citizen's place in it.
    */
    expect(isUnsurveyed(emptyBuilding([]))).toBe(true);
    expect(billableUnits(emptyBuilding([]))).toEqual([]);
  });

  /*
    What *does* make such a card assessable is `UnitOccupancy`, because it is
    the only table that is per-citizen. This is the question P2-T8 left open,
    now answered.
  */
  it('bills the flats the citizen is actually recorded in', () => {
    const entry = emptyBuilding([
      { role: 'OWNER', unitType: 'APARTMENT', unitArea: 120 },
      { role: 'OWNER', unitType: 'SHOP', unitArea: 40 },
    ]);

    expect(isUnsurveyed(entry)).toBe(false);

    const outcome = assessCitizen([entry], { amount: 1000, basis: 'PER_UNIT' });
    expect(outcome.kind).toBe('assessed');
    if (outcome.kind !== 'assessed') return;
    // Two flats — not one phantom unit, and not the building's whole matrix.
    expect(outcome.assessment.unitCount).toBe(2);
    expect(outcome.amount).toBe(2000);
  });

  it('takes each flat’s role from the occupancy, not from the card', () => {
    /*
      The one place a role legitimately comes from `UnitOccupancy`. These rows
      are selected *by citizen*, so each already names this person's capacity in
      that specific flat — an owner abroad and the tenant living in their flat
      are two rows on one unit, and picking by citizen picks the right one.

      The card says OWNER. The census says this person rents one flat and owns
      another, which is ordinary and which a single card-level role cannot say.
    */
    const entry = emptyBuilding([
      { role: 'TENANT', unitType: 'APARTMENT', unitArea: 120 },
      { role: 'OWNER', unitType: 'APARTMENT', unitArea: 90 },
    ]);

    expect(billableUnits(entry).map((unit) => unit.occupancyType)).toEqual(['TENANT', 'OWNER']);

    // The bearer rule then does its ordinary work over them: an owner-borne fee
    // reaches the owned flat and not the rented one.
    const outcome = assessCitizen([entry], { amount: 1000, basis: 'PER_UNIT', bearer: 'OWNER' });
    expect(outcome.kind).toBe('assessed');
    if (outcome.kind !== 'assessed') return;
    expect(outcome.assessment.unitCount).toBe(1);
    expect(outcome.assessment.excludedUnitCount).toBe(1);
  });

  it('never counts a card’s own units and its occupancies together', () => {
    /*
      The double-count the ordering exists to prevent. A card that itemises its
      flats is the citizen's own statement of what they hold; their occupancies
      on the same building describe the same flats from the municipality's side.
      Adding the two would bill a landlord twice for one building.
    */
    const entry: BillablePropertyEntry = {
      ...emptyBuilding([
        { role: 'OWNER', unitType: 'APARTMENT', unitArea: 120 },
        { role: 'OWNER', unitType: 'APARTMENT', unitArea: 110 },
      ]),
      units: [
        { unitType: 'APARTMENT', unitArea: 120, unitStatus: null },
        { unitType: 'APARTMENT', unitArea: 110, unitStatus: null },
      ],
    };

    expect(billableUnits(entry)).toHaveLength(2);
  });

  it('does not let occupancies stand in for a منزل’s own card', () => {
    /*
      Only a BUILDING card defers to occupancies. A منزل keeps its single unit
      on the card itself, so "no unit rows" is its normal shape rather than a
      gap — reading occupancies there would replace the citizen's own record of
      their house with whatever the matrix happened to say.
    */
    const house: BillablePropertyEntry = {
      ...card('HOUSE', '1553', 'INDEPENDENT_HOUSE', 180),
      occupiedUnits: [{ role: 'OWNER', unitType: 'SHOP', unitArea: 40 }],
    };

    const units = billableUnits(house);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual(
      expect.objectContaining({ unitType: 'INDEPENDENT_HOUSE', unitArea: 180 }),
    );
  });

  it('refuses a per-area bill over an occupancy with no recorded area', () => {
    // The existing guard reaches these units too — read as zero the flat is
    // free, read as a default it is fiction with a number attached.
    const entry = emptyBuilding([{ role: 'OWNER', unitType: 'APARTMENT', unitArea: null }]);

    expect(assessCitizen([entry], { amount: 100, basis: 'PER_AREA' }).kind).toBe('unassessable');
  });
});
describe('billable units — one list from two storage shapes', () => {
  it('reads a building as its unit rows', () => {
    const units = billableUnits(building('1553', [['SHOP', 40], ['APARTMENT', 120]]));

    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.unitType)).toEqual(['SHOP', 'APARTMENT']);
  });

  it('reads a plot as the single unit sitting flat on the card', () => {
    const units = billableUnits(card('LAND', '1553', null, 800));

    expect(units).toEqual([
      {
        unitType: null,
        unitArea: 800,
        unitStatus: null,
        occupancyType: 'OWNER',
        propertyType: 'LAND',
        propertyNumber: '1553',
      },
    ]);
  });

  it('reads several structures on one parcel as several units', () => {
    // The case this whole change exists for: one deed, three things on it.
    const entries = [
      building('1553', [['APARTMENT', 100]]),
      card('HOUSE', '1553', 'INDEPENDENT_HOUSE', 90),
      card('LAND', '1553', null, 400),
    ];

    expect(entries.flatMap(billableUnits)).toHaveLength(3);
  });

  it('does not invent a unit for a building nobody surveyed', () => {
    const unsurveyed = building('1553', []);

    expect(isUnsurveyed(unsurveyed)).toBe(true);
    expect(billableUnits(unsurveyed)).toEqual([]);
  });
});

describe('assessment', () => {
  const shops = [building('1553', [['SHOP', 40], ['SHOP', 25], ['APARTMENT', 120]])];

  it('charges six shops six times what it charges one', () => {
    const one = assessCitizen([building('1', [['SHOP', 40]])], {
      amount: 100_000,
      basis: 'PER_UNIT',
      targetCategory: 'SHOP',
    });
    const six = assessCitizen(
      [building('2', Array.from({ length: 6 }, () => ['SHOP', 40] as [string, number]))],
      { amount: 100_000, basis: 'PER_UNIT', targetCategory: 'SHOP' },
    );

    expect(one.kind).toBe('assessed');
    expect(six.kind).toBe('assessed');
    expect(one.kind === 'assessed' && one.amount).toBe(100_000);
    expect(six.kind === 'assessed' && six.amount).toBe(600_000);
  });

  it('counts only the units the notice is aimed at', () => {
    const result = assessCitizen(shops, {
      amount: 50_000,
      basis: 'PER_UNIT',
      targetCategory: 'SHOP',
    });

    // The apartment in the same building is not a shop and is not billed.
    expect(result.kind === 'assessed' && result.amount).toBe(100_000);
    expect(result.kind === 'assessed' && result.assessment.unitCount).toBe(2);
  });

  it('bills by area when that is the basis', () => {
    const result = assessCitizen(shops, {
      amount: 1_000,
      basis: 'PER_AREA',
      targetCategory: 'SHOP',
    });

    expect(result.kind === 'assessed' && result.amount).toBe(65_000);
    expect(result.kind === 'assessed' && result.assessment.totalArea).toBe(65);
  });

  it('leaves a flat notice charging exactly what it always did', () => {
    const result = assessCitizen(shops, { amount: 250_000, basis: 'FLAT' });

    // Nothing is multiplied: FLAT is the original behaviour, and every notice
    // written before per-unit billing existed is one.
    expect(result.kind === 'assessed' && result.amount).toBe(250_000);
  });

  it('keeps a breakdown that explains the number at the counter', () => {
    const result = assessCitizen(shops, {
      amount: 50_000,
      basis: 'PER_UNIT',
      targetCategory: 'SHOP',
    });

    expect(result.kind === 'assessed' && result.assessment.lines).toEqual([
      { propertyNumber: '1553', propertyType: 'BUILDING', unitType: 'SHOP', unitArea: null },
      { propertyNumber: '1553', propertyType: 'BUILDING', unitType: 'SHOP', unitArea: null },
    ]);
  });

  it('refuses to bill a building nobody has been inside', () => {
    // The trap: counted as zero, the largest building in the municipality pays
    // nothing, and the fee schedule is most generous to the biggest property.
    const result = assessCitizen([building('1553', [])], {
      amount: 100_000,
      basis: 'PER_UNIT',
      targetCategory: 'SHOP',
    });

    expect(result.kind).toBe('unassessable');
    expect(result.kind === 'unassessable' && result.reason).toContain('1553');
  });

  it('does not let an unsurveyed building block a flat charge', () => {
    /*
      A flat notice does not ask the register anything — its amount *is* the
      invoice. Refusing it because a building was never surveyed would drop a
      citizen out of a billing run over a number the bill never depended on.
    */
    const result = assessCitizen([building('1553', [])], { amount: 250_000, basis: 'FLAT' });

    expect(result.kind === 'assessed' && result.amount).toBe(250_000);
  });

  it('does not let an unsurveyed building block a fee aimed at land', () => {
    /*
      Units inside a building are always BUILDING-typed, so nothing found by
      surveying one can add or remove a matching unit from an أرض notice. The
      citizen's plot is measurable and must still be billed — blocking here
      under-collects for exactly the reason the refusal exists to prevent.
    */
    const result = assessCitizen([building('1553', []), card('LAND', '1554', null, 800)], {
      amount: 1_000,
      basis: 'PER_AREA',
      targetCategory: 'LAND',
    });

    expect(result.kind === 'assessed' && result.amount).toBe(800_000);
  });

  it('still blocks an unsurveyed building when the fee could reach inside it', () => {
    // The same building, a notice aimed at BUILDING rather than LAND.
    const result = assessCitizen([building('1553', []), card('LAND', '1554', null, 800)], {
      amount: 100_000,
      basis: 'PER_UNIT',
      targetCategory: 'BUILDING',
    });

    expect(result.kind).toBe('unassessable');
  });

  it('refuses to bill by area for a unit with no area recorded', () => {
    const result = assessCitizen([building('1553', [['SHOP', null]])], {
      amount: 1_000,
      basis: 'PER_AREA',
      targetCategory: 'SHOP',
    });

    expect(result.kind).toBe('unassessable');
  });

  /**
   * Who bears the fee — the rule deciding which of a citizen's units are
   * theirs to pay for.
   *
   * The table below is exhaustive on purpose. There are only fourteen
   * reachable combinations of occupancy, unit status and bearer; every one of
   * them decides money, and several read as obviously right in prose and come
   * out inverted in code. Enumerating them is cheaper than trusting four lines
   * of `bearsFee` to keep reading correctly forever.
   */
  describe('bearer', () => {
    const rate = { amount: 100_000, basis: 'PER_UNIT' as const, targetCategory: 'SHOP' };

    /** One shop, held as described, and whether each bearer charges for it. */
    const cases: Array<{
      occupancyType: string;
      unitStatus?: string;
      occupant: boolean;
      owner: boolean;
      why: string;
    }> = [
      {
        occupancyType: 'OWNER',
        occupant: true,
        owner: true,
        why: 'nobody was asked, so the owner is presumed to be in it',
      },
      {
        occupancyType: 'OWNER',
        unitStatus: 'OWNER_OCCUPIED',
        occupant: true,
        owner: true,
        why: 'the owner is the occupant',
      },
      {
        occupancyType: 'OWNER',
        unitStatus: 'RENTED',
        occupant: false,
        owner: true,
        why: 'the tenant is billed for it on their own card',
      },
      {
        occupancyType: 'OWNER',
        unitStatus: 'VACANT',
        occupant: false,
        owner: true,
        why: 'nobody occupies it, but it is still owned',
      },
      {
        occupancyType: 'OWNER',
        unitStatus: 'UNDER_CONSTRUCTION',
        occupant: false,
        owner: true,
        why: 'not finished, still owned',
      },
      {
        occupancyType: 'TENANT',
        occupant: true,
        owner: false,
        why: 'a tenant occupies but owns nothing',
      },
      {
        occupancyType: 'FREE_OCCUPANT',
        occupant: true,
        owner: false,
        why: 'a free occupant occupies but owns nothing',
      },
      /*
        The two rows this table could not previously express, and whose absence
        was a live double-charge rather than a gap in coverage.

        `UnitStatus` had no value for «somebody is living here without a lease»,
        so an owner in that position answered OWNER_OCCUPIED — the only value
        left — and `bearsFee` read it as "the owner is the شاغل" and charged
        them, while the شاغل بتسامح was charged on their own card. The owner who
        lied and said «مؤجرة» escaped; the one who answered honestly paid.
      */
      {
        occupancyType: 'OWNER',
        unitStatus: 'FREE_OCCUPIED',
        occupant: false,
        owner: true,
        why: 'someone else lives there rent-free — they are billed, not the owner',
      },
      {
        occupancyType: 'OWNER',
        unitStatus: 'RENTED',
        occupant: false,
        owner: true,
        why: 'let out — the tenant is billed on their own card',
      },
      /*
        «مسكن موسمي» — an expatriate family's flat used in summer.

        Pinned to the owner on purpose: a building is presumed occupied until a
        تصريح بالشغور is filed (هيئة التشريع والاستشارات 725/2003), so without
        one the full year is owed and the owner is the شاغل who owes it. If a
        later change moves SEASONAL into an exemption list, this fails — which
        is the point, because that would be a council decision, not a refactor.
      */
      {
        occupancyType: 'OWNER',
        unitStatus: 'SEASONAL',
        occupant: true,
        owner: true,
        why: 'a seasonal home is still the owner’s to pay for until vacancy is declared',
      },
    ];

    for (const entry of cases) {
      const held = entry.unitStatus
        ? `${entry.occupancyType} / ${entry.unitStatus}`
        : `${entry.occupancyType} / unrecorded`;

      const one = (): BillablePropertyEntry =>
        building(
          '1553',
          [entry.unitStatus ? ['SHOP', 40, entry.unitStatus] : ['SHOP', 40]],
          entry.occupancyType,
        );

      it(`occupant-borne: ${entry.occupant ? 'charges' : 'skips'} ${held} — ${entry.why}`, () => {
        const result = assessCitizen([one()], { ...rate, bearer: 'OCCUPANT' });

        expect(result.kind === 'assessed' && result.amount).toBe(entry.occupant ? 100_000 : 0);
      });

      it(`owner-borne: ${entry.owner ? 'charges' : 'skips'} ${held} — ${entry.why}`, () => {
        const result = assessCitizen([one()], { ...rate, bearer: 'OWNER' });

        expect(result.kind === 'assessed' && result.amount).toBe(entry.owner ? 100_000 : 0);
      });
    }

    /** A landlord's two flats — one they live in, one they have let. */
    const landlord = () =>
      building('1553', [
        ['APARTMENT', 100, 'OWNER_OCCUPIED'],
        ['APARTMENT', 100, 'RENTED'],
      ]);

    /** The tenant of that second flat, filing their own card on the same parcel. */
    const tenant = () => building('1553', [['APARTMENT', 100]], 'TENANT');

    const flats = {
      amount: 100_000,
      basis: 'PER_UNIT' as const,
      targetCategory: 'APARTMENT',
    };

    it('ends the double-charge on a flat the owner has let', () => {
      /*
        The case the whole enum exists for, both halves of it in one test.

        A building is filed once by its owner and again by the tenant of one
        flat — the same apartment under two citizens, which is correct, because
        ownership and occupancy are different facts about it. Under an
        occupant-borne fee exactly one of them owes for it: the tenant. Before
        this, both did, and the municipality collected twice for one flat.
      */
      const landlordBill = assessCitizen([landlord()], { ...flats, bearer: 'OCCUPANT' });
      const tenantBill = assessCitizen([tenant()], { ...flats, bearer: 'OCCUPANT' });

      expect(landlordBill.kind === 'assessed' && landlordBill.amount).toBe(100_000);
      expect(tenantBill.kind === 'assessed' && tenantBill.amount).toBe(100_000);

      // Two flats on the parcel, two charges raised — not three.
      const total =
        (landlordBill.kind === 'assessed' ? landlordBill.amount : 0) +
        (tenantBill.kind === 'assessed' ? tenantBill.amount : 0);
      expect(total).toBe(200_000);
    });

    it('ends the double-charge on a flat occupied rent-free', () => {
      /*
        The same shape as the test above, for the third way of being the شاغل —
        and the one that had no escape at all until `FREE_OCCUPIED` existed.

        A father's building, one flat lived in by his son with no بدل. The son
        files his own card as a شاغل بتسامح, which always bears an occupant fee
        (he is by definition the occupant of what he filed). The father's card
        had no way to say so, so the flat read as owner-occupied and he was
        charged for it too — two charges, one flat, both rows individually
        valid and nothing anywhere logging it.

        Deliberately asserted as a *pair*. Either card alone passes in both the
        broken and the fixed world, which is exactly why a suite of single-card
        assessments stayed green over a defect that doubled somebody's bill.
      */
      const father = () =>
        building('1553', [
          ['APARTMENT', 100, 'OWNER_OCCUPIED'],
          ['APARTMENT', 100, 'FREE_OCCUPIED'],
        ]);
      const son = () => building('1553', [['APARTMENT', 100]], 'FREE_OCCUPANT');

      const fatherBill = assessCitizen([father()], { ...flats, bearer: 'OCCUPANT' });
      const sonBill = assessCitizen([son()], { ...flats, bearer: 'OCCUPANT' });

      expect(fatherBill.kind === 'assessed' && fatherBill.amount).toBe(100_000);
      expect(sonBill.kind === 'assessed' && sonBill.amount).toBe(100_000);

      // Two flats on the parcel, two charges raised — not three.
      const total =
        (fatherBill.kind === 'assessed' ? fatherBill.amount : 0) +
        (sonBill.kind === 'assessed' ? sonBill.amount : 0);
      expect(total).toBe(200_000);
    });

    it('still bills the owner of a rent-free flat when the fee is owner-borne', () => {
      /*
        The half that must *not* move. «مشغولة بتسامح» exempts the owner from
        the occupancy fee and from nothing else — they still hold the deed, the
        pavement outside is still theirs, and the شاغل owns none of it. An
        exemption written as "this unit is somebody else's problem" rather than
        "somebody else is the شاغل" would have quietly stopped collecting
        الأرصفة on every flat a relative lives in.
      */
      const father = () =>
        building('1553', [
          ['APARTMENT', 100, 'OWNER_OCCUPIED'],
          ['APARTMENT', 100, 'FREE_OCCUPIED'],
        ]);
      const son = () => building('1553', [['APARTMENT', 100]], 'FREE_OCCUPANT');

      const fatherBill = assessCitizen([father()], { ...flats, bearer: 'OWNER' });
      const sonBill = assessCitizen([son()], { ...flats, bearer: 'OWNER' });

      expect(fatherBill.kind === 'assessed' && fatherBill.amount).toBe(200_000);
      expect(sonBill.kind === 'assessed' && sonBill.amount).toBe(0);
    });

    it('bills the owner for both flats when the fee is owner-borne', () => {
      // A pavement fee does not care who sleeps there, and the tenant owes none
      // of it — they own nothing.
      const landlordBill = assessCitizen([landlord()], { ...flats, bearer: 'OWNER' });
      const tenantBill = assessCitizen([tenant()], { ...flats, bearer: 'OWNER' });

      expect(landlordBill.kind === 'assessed' && landlordBill.amount).toBe(200_000);
      expect(tenantBill.kind === 'assessed' && tenantBill.amount).toBe(0);
    });

    it('defaults to the occupant, and to the arithmetic that came before it', () => {
      /*
        The compatibility guarantee, stated as a test.

        On a register where nobody has recorded a unit status, every unit reads
        as null — presumed occupied by its owner — so an occupant-borne notice
        charges for all of them. That is exactly what the biller did before any
        of this existed, which is what makes OCCUPANT safe to default to, and
        why the correction only switches itself on as landlords actually mark
        units as let.
      */
      const unmarked = [building('1553', [['SHOP', 40], ['SHOP', 25], ['SHOP', 30]])];

      const defaulted = assessCitizen(unmarked, rate);
      const explicit = assessCitizen(unmarked, { ...rate, bearer: 'OCCUPANT' });

      expect(defaulted.kind === 'assessed' && defaulted.amount).toBe(300_000);
      expect(explicit.kind === 'assessed' && explicit.amount).toBe(300_000);
    });

    it('counts what it left out, so the invoice can say so', () => {
      const result = assessCitizen(
        [
          building('1553', [
            ['SHOP', 40, 'OWNER_OCCUPIED'],
            ['SHOP', 25, 'RENTED'],
            ['SHOP', 30, 'VACANT'],
          ]),
        ],
        { ...rate, bearer: 'OCCUPANT' },
      );

      expect(result.kind === 'assessed' && result.amount).toBe(100_000);
      expect(result.kind === 'assessed' && result.assessment.unitCount).toBe(1);
      expect(result.kind === 'assessed' && result.assessment.excludedUnitCount).toBe(2);
    });

    it('excludes nothing when every unit is borne by the person assessed', () => {
      const result = assessCitizen([building('1553', [['SHOP', 40]])], {
        ...rate,
        bearer: 'OCCUPANT',
      });

      expect(result.kind === 'assessed' && result.assessment.excludedUnitCount).toBe(0);
    });

    it('applies the same rule to a house filed on its own card', () => {
      // The two storage shapes have to agree, or what someone owes would depend
      // on how the register happened to file their property.
      const rented = card('HOUSE', '1554', 'INDEPENDENT_HOUSE', 90, { unitStatus: 'RENTED' });
      const notice = {
        amount: 100_000,
        basis: 'PER_UNIT' as const,
        targetCategory: 'INDEPENDENT_HOUSE',
      };

      const asOccupant = assessCitizen([rented], { ...notice, bearer: 'OCCUPANT' });
      const asOwner = assessCitizen([rented], { ...notice, bearer: 'OWNER' });

      expect(asOccupant.kind === 'assessed' && asOccupant.amount).toBe(0);
      expect(asOwner.kind === 'assessed' && asOwner.amount).toBe(100_000);
    });

    it('measures only the units it charges for, under a per-area fee', () => {
      const result = assessCitizen(
        [
          building('1553', [
            ['SHOP', 40, 'OWNER_OCCUPIED'],
            ['SHOP', 25, 'RENTED'],
          ]),
        ],
        { amount: 1_000, basis: 'PER_AREA', targetCategory: 'SHOP', bearer: 'OCCUPANT' },
      );

      expect(result.kind === 'assessed' && result.assessment.totalArea).toBe(40);
      expect(result.kind === 'assessed' && result.amount).toBe(40_000);
    });

    it('does not refuse a per-area bill over a unit it is not charging for', () => {
      /*
        A missing area on a flat this person does not owe for cannot change what
        they owe, so stranding the whole household over it would be a refusal
        that protects nothing.
      */
      const result = assessCitizen(
        [
          building('1553', [
            ['SHOP', 40, 'OWNER_OCCUPIED'],
            ['SHOP', null, 'RENTED'],
          ]),
        ],
        { amount: 1_000, basis: 'PER_AREA', targetCategory: 'SHOP', bearer: 'OCCUPANT' },
      );

      expect(result.kind === 'assessed' && result.amount).toBe(40_000);
    });

    it('still refuses a per-area bill over a unit it is charging for', () => {
      const result = assessCitizen([building('1553', [['SHOP', null, 'OWNER_OCCUPIED']])], {
        amount: 1_000,
        basis: 'PER_AREA',
        targetCategory: 'SHOP',
        bearer: 'OCCUPANT',
      });

      expect(result.kind).toBe('unassessable');
    });

    it('never lets the bearer reach a flat charge', () => {
      // FLAT does not ask the register what anyone holds, so there is no unit
      // for a bearer rule to include or exclude. A tenant still owes it.
      const result = assessCitizen([tenant()], {
        amount: 250_000,
        basis: 'FLAT',
        bearer: 'OWNER',
      });

      expect(result.kind === 'assessed' && result.amount).toBe(250_000);
    });

    it('keeps a breakdown listing only the units actually charged', () => {
      const result = assessCitizen(
        [
          building('1553', [
            ['SHOP', 40, 'OWNER_OCCUPIED'],
            ['SHOP', 25, 'VACANT'],
          ]),
        ],
        { ...rate, bearer: 'OCCUPANT' },
      );

      expect(result.kind === 'assessed' && result.assessment.lines).toEqual([
        { propertyNumber: '1553', propertyType: 'BUILDING', unitType: 'SHOP', unitArea: null },
      ]);
    });
  });

  it('reaches a standalone house through the unit-type category it carries', () => {
    /*
      «منازل مستقلة» is a unit-type category and a منزل carries its type on the
      card rather than in a `units` row. Matching only inside `units` — which is
      what the target query did — found buildings and missed every house in the
      register, so the notice reported that nobody held the category.
    */
    const result = assessCitizen([card('HOUSE', '1553', 'INDEPENDENT_HOUSE', 90)], {
      amount: 100_000,
      basis: 'PER_UNIT',
      targetCategory: 'INDEPENDENT_HOUSE',
    });

    expect(result.kind === 'assessed' && result.amount).toBe(100_000);
  });

  it('does not let an unsurveyed building block a fee aimed at houses', () => {
    /*
      The one unit type a building cannot contain: an INDEPENDENT_HOUSE is what
      a whole HOUSE card is, so surveying the building can never turn up
      another. Blocking here would strand a citizen over a number the notice
      never depended on — the same silent under-collection the refusal exists
      to prevent, arrived at backwards.
    */
    const result = assessCitizen(
      [building('1553', []), card('HOUSE', '1554', 'INDEPENDENT_HOUSE', 90)],
      { amount: 100_000, basis: 'PER_UNIT', targetCategory: 'INDEPENDENT_HOUSE' },
    );

    expect(result.kind === 'assessed' && result.amount).toBe(100_000);
  });

  it('still blocks an unsurveyed building for a category it could be hiding', () => {
    // مستودع is exactly what an unsurveyed building might hold.
    const result = assessCitizen([building('1553', [])], {
      amount: 100_000,
      basis: 'PER_UNIT',
      targetCategory: 'WAREHOUSE',
    });

    expect(result.kind).toBe('unassessable');
  });

  it('bills a citizen who holds none of it nothing at all', () => {
    // Not an error — they simply owe zero, and the caller raises no invoice.
    const result = assessCitizen([card('LAND', '1553', null, 800)], {
      amount: 100_000,
      basis: 'PER_UNIT',
      targetCategory: 'SHOP',
    });

    expect(result.kind === 'assessed' && result.amount).toBe(0);
  });
});
