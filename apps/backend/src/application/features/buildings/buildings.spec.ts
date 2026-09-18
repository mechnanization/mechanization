import {
  buildingFilterSchema,
  createBuildingSchema,
  createDamageAssessmentSchema,
  unitBlueprintSchema,
  upsertOccupancySchema,
} from '@mechanization/shared-schemas';
import {
  changedBuildingFields,
  partitionNumbersFor,
  rollupOf,
  sharedParcelsExcluding,
  sortByDistance,
} from './buildings.service';
import { damageSeverity, worstDamage } from './damage.service';

/**
 * The census's rules that are decidable without a database.
 *
 * The rollup and the damage ladder are the two places a wrong answer is
 * invisible: both produce a plausible colour on a map, and nobody checks a
 * colour against the rows behind it. So they are pinned here rather than left
 * to an integration test that would need a Postgres to say anything at all.
 */

describe('survey rollup — the worst status, never the majority (D11)', () => {
  it('takes the worst of a mixed building', () => {
    // The case D11 exists for. Eleven surveyed flats and one nobody answered is
    // not a surveyed building — the twelfth is the reason to send somebody, and
    // colouring the pin "complete" hides the one fact the map was drawn to show.
    const eleven = Array.from({ length: 11 }, () => 'COMPLETE');
    expect(rollupOf([...eleven, 'NOT_SURVEYED'])).toBe('NOT_SURVEYED');
  });

  it('reports a fully surveyed building as complete', () => {
    expect(rollupOf(['COMPLETE', 'COMPLETE', 'VACANT_CONFIRMED'])).toBe('COMPLETE');
  });

  it('treats a building with no units as unsurveyed, not as finished', () => {
    /*
      An empty shell is a structure whose matrix nobody has filled in, not a
      structure with nothing in it — the same judgement `isUnsurveyed` makes in
      billing. Returning `COMPLETE` for it would paint every newly created
      building green the moment it was created.
    */
    expect(rollupOf([])).toBe('NOT_SURVEYED');
  });

  it('ranks a never-attempted door above one that was knocked on', () => {
    // Both are work; only one has already cost somebody a trip.
    expect(rollupOf(['VISITED_NO_ANSWER', 'NOT_SURVEYED'])).toBe('NOT_SURVEYED');
  });

  it('ranks a dead end above a partial record', () => {
    // REFUSED and INACCESSIBLE need a person to decide what happens next;
    // PARTIAL just needs another visit.
    expect(rollupOf(['PARTIAL', 'REFUSED'])).toBe('REFUSED');
    expect(rollupOf(['PARTIAL', 'INACCESSIBLE'])).toBe('INACCESSIBLE');
  });

  it('treats a finding as a finding, however unwelcome', () => {
    // The census has its answer; the answer happens not to be a household.
    expect(rollupOf(['DEMOLISHED', 'VACANT_CONFIRMED', 'COMPLETE'])).toBe('COMPLETE');
  });

  it('does not take a map down over a status nobody added to the ladder', () => {
    expect(rollupOf(['COMPLETE', 'SOMETHING_NEW'])).toBe('COMPLETE');
  });
});

describe('الفرز — the أقسام a partition produced, and when they may exist', () => {
  /*
    The two columns migration 0047 adds are one fact, and this is the rule that
    keeps them in step. أقسام under a structure nobody has recorded a فرز for is
    not a partial record — it is a contradiction, and one a later deed search
    would read as fact.
  */
  it('keeps the أقسام only where a فرز was actually recorded', () => {
    expect(partitionNumbersFor(true, ['12', '13'])).toEqual(['12', '13']);
    expect(partitionNumbersFor(false, ['12', '13'])).toEqual([]);
    expect(partitionNumbersFor(null, ['12', '13'])).toEqual([]);
    expect(partitionNumbersFor(undefined, ['12', '13'])).toEqual([]);
  });

  it('allows a فرز nobody has the numbers for yet', () => {
    /*
      Ordinary, not incomplete. A block is visibly مفروزة from the street long
      before anyone has the صحيفة عقارية in front of them, and refusing the
      flag without its numbers would mean the officer who can see the first
      fact has to withhold it until somebody establishes the second.
    */
    expect(partitionNumbersFor(true, [])).toEqual([]);
    expect(partitionNumbersFor(true, undefined)).toEqual([]);
  });

  it('collapses repeats and drops blanks rather than refusing the save', () => {
    expect(partitionNumbersFor(true, ['12', ' 12 ', '', '  ', '13'])).toEqual(['12', '13']);
  });
});

describe('BUILDING_UPDATED — the audit row names what changed', () => {
  const building = {
    name: 'بناية النور',
    postedNumber: null,
    isPartitioned: null,
    partitionNumbers: [] as string[],
    sharedParcelNumbers: [] as string[],
    structureType: 'RESIDENTIAL_BUILDING',
    lifecycleStatus: 'IN_USE',
    latitude: 33.2,
    longitude: 35.2,
    floorsCount: 2,
    basementsCount: 0,
    notes: null,
  };

  it('records a فرز and its أقسام, which the old row never logged', () => {
    const after = { ...building, isPartitioned: true, partitionNumbers: ['12', '13'] };
    expect(changedBuildingFields(building, after)).toEqual({
      before: { isPartitioned: null, partitionNumbers: [] },
      after: { isPartitioned: true, partitionNumbers: ['12', '13'] },
    });
  });

  it('records nothing for a save that changed nothing', () => {
    expect(changedBuildingFields(building, { ...building, partitionNumbers: [] })).toEqual({
      before: {},
      after: {},
    });
  });

  it('records a moved pin and shared parcels', () => {
    const after = { ...building, latitude: 33.21, sharedParcelNumbers: ['25'] };
    expect(Object.keys(changedBuildingFields(building, after).after)).toEqual([
      'sharedParcelNumbers',
      'latitude',
    ]);
  });
});

describe('the duplicate-building prompt — nearest structure first', () => {
  /*
    Parcel 56: the second and third records were created 3.6 m and 4.1 m from
    the first, by officers shown a list ordered by code. The distance is the
    fact that settles "is this the same building", so it leads.
  */
  it('puts the closest measured structure first', () => {
    const rows = [
      { code: 'Z-3-56-A', distanceMetres: 40 },
      { code: 'Z-3-56-B', distanceMetres: 4 },
      { code: 'Z-3-56-C', distanceMetres: 12 },
    ];
    expect(sortByDistance(rows).map((row) => row.code)).toEqual([
      'Z-3-56-B',
      'Z-3-56-C',
      'Z-3-56-A',
    ]);
  });

  it('keeps unmeasured structures after the measured ones, in the order given', () => {
    // No pin on either side is "we cannot tell", never "zero metres".
    const rows = [
      { code: 'A', distanceMetres: null },
      { code: 'B', distanceMetres: 30 },
      { code: 'C', distanceMetres: null },
      { code: 'D', distanceMetres: 0 },
    ];
    expect(sortByDistance(rows).map((row) => row.code)).toEqual(['D', 'B', 'A', 'C']);
  });

  it('leaves a parcel with no pins at all exactly as it was ordered', () => {
    const rows = [
      { code: 'own-A', distanceMetres: null },
      { code: 'own-B', distanceMetres: null },
      { code: 'shared-A', distanceMetres: null },
    ];
    expect(sortByDistance(rows)).toEqual(rows);
  });
});

describe('العقارات المشتركة — the parcels beside the one the code comes from', () => {
  it('never lets a building straddle itself', () => {
    /*
      The building's own عقار in its "also stands on" list is a repetition, not
      a second parcel — and stored, it becomes a straddling structure in a
      figure nobody would think to check against the parcel it is already filed
      under. Trimmed before comparing, because the field it comes from is typed.
    */
    expect(sharedParcelsExcluding(['1042', '1043'], '1042')).toEqual(['1043']);
    expect(sharedParcelsExcluding([' 1042 '], '1042')).toEqual([]);
    expect(sharedParcelsExcluding(['1043'], ' 1042 ')).toEqual(['1043']);
  });

  it('collapses repeats and drops blanks rather than refusing the save', () => {
    // The officer adding a row twice expressed the right intent, and a blank row
    // is one they opened and did not fill in. Neither is worth a refusal.
    expect(sharedParcelsExcluding(['1043', '1043', '', '  ', '1044'], '1042')).toEqual([
      '1043',
      '1044',
    ]);
  });

  it('reads an absent list as "stands on one parcel"', () => {
    expect(sharedParcelsExcluding(undefined, '1042')).toEqual([]);
    expect(sharedParcelsExcluding([], '1042')).toEqual([]);
  });
});

describe('damage severity — the ladder a building rolls up', () => {
  it('orders the UN-Habitat scale worst first', () => {
    expect(damageSeverity('TOTAL_COLLAPSE')).toBeLessThan(damageSeverity('UNSAFE_EVACUATE'));
    expect(damageSeverity('UNSAFE_EVACUATE')).toBeLessThan(damageSeverity('RESTRICTED_USE'));
    expect(damageSeverity('RESTRICTED_USE')).toBeLessThan(damageSeverity('SAFE_MINOR_DAMAGE'));
    expect(damageSeverity('SAFE_MINOR_DAMAGE')).toBeLessThan(damageSeverity('NOT_AFFECTED'));
  });

  it('does not let an unassessed building outrank an inspected one', () => {
    /*
      `UNCLASSIFIED` is not a severity — it means nobody has judged this
      building. Ranking it as "least damaged" would let it beat `NOT_AFFECTED`
      in a worst-case rollup, which reads on the map as "we checked and it is
      fine".
    */
    expect(damageSeverity('NOT_AFFECTED')).toBeLessThan(damageSeverity('UNCLASSIFIED'));
  });

  it('picks the worse of two levels, and tolerates a missing one', () => {
    expect(worstDamage('SAFE_MINOR_DAMAGE', 'TOTAL_COLLAPSE')).toBe('TOTAL_COLLAPSE');
    expect(worstDamage(null, 'RESTRICTED_USE')).toBe('RESTRICTED_USE');
    expect(worstDamage('RESTRICTED_USE', null)).toBe('RESTRICTED_USE');
    expect(worstDamage(null, null)).toBeNull();
  });
});

describe('createBuildingSchema', () => {
  const valid = {
    parcelNumber: '1042',
    structureType: 'RESIDENTIAL_BUILDING',
  };

  it('accepts the minimum a desk can supply', () => {
    // A building may be created before anyone has stood at its door, so a pin
    // is not required — see `Building.latitude`.
    const result = createBuildingSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.floorsCount).toBe(1);
  });

  it('refuses half a pin', () => {
    /*
      One coordinate without the other is not a partial location — it is a point
      on the null meridian, silently plotted in the Gulf of Guinea. Two
      independent optional numbers would have accepted it.
    */
    expect(createBuildingSchema.safeParse({ ...valid, latitude: 33.26 }).success).toBe(false);
    expect(createBuildingSchema.safeParse({ ...valid, longitude: 35.26 }).success).toBe(false);
    expect(
      createBuildingSchema.safeParse({ ...valid, latitude: 33.26, longitude: 35.26 }).success,
    ).toBe(true);
  });

  it('will not take a code from a client', () => {
    // The UUID is the identity and the code is derived (D9). A client that
    // could send one could send a code contradicting the parcel it names.
    const result = createBuildingSchema.safeParse({ ...valid, code: 'Z-9999-Z' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('code');
  });

  it('carries the provisional suffix a phone was showing', () => {
    const result = createBuildingSchema.safeParse({ ...valid, provisionalSuffix: 'A' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.provisionalSuffix).toBe('A');
  });

  /*
    «هل الوحدة مفروزة على عقار» — three answers, and the third is silence.

    فرز decides whether a flat inside can carry a deed of its own. A boolean
    that defaulted to `false` would have every building ever recorded asserting
    «غير مفروزة» — a statement about title that no officer made — so the absence
    has to survive the parse rather than being filled in.
  */
  it('keeps «not established» distinct from «not partitioned»', () => {
    /*
      The wizard's control is a single checkbox and sends `true` or nothing, so
      `false` is currently unreachable from the UI. The schema keeps it anyway:
      «we read the صحيفة and there is no فرز» is a finding, and it is not the
      same as never having looked. A schema that collapsed the two would make
      the distinction unrecoverable the day a form wants to record it.
    */
    const unasked = createBuildingSchema.safeParse(valid);
    expect(unasked.success).toBe(true);
    if (!unasked.success) return;
    expect(unasked.data.isPartitioned).toBeUndefined();

    const answeredNo = createBuildingSchema.safeParse({ ...valid, isPartitioned: false });
    expect(answeredNo.success).toBe(true);
    if (!answeredNo.success) return;
    expect(answeredNo.data.isPartitioned).toBe(false);
  });

  it('carries أرقام الأقسام beside the فرز flag', () => {
    const result = createBuildingSchema.safeParse({
      ...valid,
      isPartitioned: true,
      partitionNumbers: ['12', ' 12 ', '13'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // De-duplicated on the way in, like every other list on this shape. The
    // *pairing* with the flag is the service's rule — see `partitionNumbersFor`.
    expect(result.data.partitionNumbers).toEqual(['12', '13']);
  });

  /*
    «إن كانت الوحدة مشتركة على أكثر من عقار».

    `parcelNumber` names the one عقار the code and the per-parcel suffix derive
    from (D9) and cannot be widened to a list. These are the others, and the
    officer adding the same row twice expressed the right intent — the same
    judgement `parcelNumbersField` makes on a zone — so a repeat is collapsed
    rather than refused.
  */
  it('collapses a repeated shared parcel rather than refusing the save', () => {
    const result = createBuildingSchema.safeParse({
      ...valid,
      sharedParcelNumbers: ['1043', ' 1043 ', '1044'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sharedParcelNumbers).toEqual(['1043', '1044']);
  });

  it('defaults to standing on exactly one parcel', () => {
    const result = createBuildingSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sharedParcelNumbers).toBeUndefined();
  });

  /*
    The registration form creates a structure and its flats in one request.

    A shell alone would link the card and record no occupancy — the census
    claims a flat only where the line carries a `unitId` — so the household
    would go unbilled with nothing anywhere to say why. These are the shapes
    that path depends on.
  */
  describe('inline units, for register-first creation', () => {
    it('takes a matrix alongside the shell', () => {
      const result = createBuildingSchema.safeParse({
        ...valid,
        units: [
          { floor: 0, unitType: 'SHOP' },
          { floor: 1, unitType: 'APARTMENT', unitArea: 120 },
        ],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.units).toHaveLength(2);
      // Allocated server-side under the building's own transaction; a client
      // that guessed one would collide with the officer filling the same floor.
      expect(result.data.units?.[0]?.sequence).toBeUndefined();
    });

    it('accepts a browser-minted id per unit', () => {
      // The offline half: a queued registration has to name a flat before the
      // row exists, exactly as it names the building before the row exists.
      const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      const result = createBuildingSchema.safeParse({
        ...valid,
        units: [{ id, floor: 2, unitType: 'APARTMENT' }],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.units?.[0]?.id).toBe(id);
    });

    it('refuses a unit id that is not a uuid', () => {
      expect(
        createBuildingSchema.safeParse({
          ...valid,
          units: [{ id: 'unit-1', floor: 0, unitType: 'APARTMENT' }],
        }).success,
      ).toBe(false);
    });

    it('accepts a matrix at the unit-grid ceiling (20x20)', () => {
      // The building editor's unit-matrix grid creates inline too, up to its
      // own 20x20 physical maximum — this cap is sized to that, not just to a
      // registration form's handful of flats.
      const units = Array.from({ length: 400 }, () => ({ floor: 1, unitType: 'APARTMENT' }));
      expect(createBuildingSchema.safeParse({ ...valid, units }).success).toBe(true);
    });

    it('refuses a matrix larger than the unit-grid ceiling', () => {
      const units = Array.from({ length: 401 }, () => ({ floor: 1, unitType: 'APARTMENT' }));
      expect(createBuildingSchema.safeParse({ ...valid, units }).success).toBe(false);
    });

    it('is still valid with no units at all', () => {
      // The editor's own path: a shell now, a blueprint next.
      const result = createBuildingSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.units).toBeUndefined();
    });
  });
});

describe('buildingFilterSchema — «بلا مدخل مُثبت»', () => {
  it('reads the querystring form the browser actually sends', () => {
    /*
      `URLSearchParams` stringifies everything, so the filter arrives as the
      text "false" and a bare `z.boolean()` would refuse it — the filter would
      look wired up and quietly never narrow anything, which is exactly the
      shape of the sector-filter defect P3-T4 found.
    */
    const result = buildingFilterSchema.safeParse({ hasEntrance: 'false' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hasEntrance).toBe(false);
  });

  it('reads a real boolean too', () => {
    expect(buildingFilterSchema.parse({ hasEntrance: true }).hasEntrance).toBe(true);
  });

  it('leaves it absent when nobody asked', () => {
    // Absent must not collapse to `false`, or the default ledger would show
    // only the structures with no pin.
    expect(buildingFilterSchema.parse({}).hasEntrance).toBeUndefined();
  });
});

describe('unitBlueprintSchema', () => {
  it('accepts "six floors, four flats each"', () => {
    const result = unitBlueprintSchema.safeParse({
      kind: 'uniform',
      fromFloor: 0,
      toFloor: 5,
      unitsPerFloor: 4,
      unitType: 'APARTMENT',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a stairwell somebody has actually walked', () => {
    const result = unitBlueprintSchema.safeParse({
      kind: 'explicit',
      floors: [
        { floor: 0, unitCount: 2, unitType: 'SHOP' },
        { floor: 1, unitCount: 4, unitType: 'APARTMENT' },
        { floor: 2, unitCount: 1, unitType: 'APARTMENT' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('refuses a floor range that runs backwards', () => {
    const result = unitBlueprintSchema.safeParse({
      kind: 'uniform',
      fromFloor: 3,
      toFloor: 1,
      unitsPerFloor: 2,
      unitType: 'APARTMENT',
    });
    expect(result.success).toBe(false);
  });

  it('refuses the same floor listed twice', () => {
    // An editing slip. Silently merging the two rows would generate a different
    // matrix from the one on screen.
    const result = unitBlueprintSchema.safeParse({
      kind: 'explicit',
      floors: [
        { floor: 1, unitCount: 2, unitType: 'APARTMENT' },
        { floor: 1, unitCount: 3, unitType: 'APARTMENT' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('generates basements', () => {
    const result = unitBlueprintSchema.safeParse({
      kind: 'uniform',
      fromFloor: -2,
      toFloor: 0,
      unitsPerFloor: 1,
      unitType: 'WAREHOUSE',
    });
    expect(result.success).toBe(true);
  });
});

describe('createDamageAssessmentSchema', () => {
  it('takes exactly one target', () => {
    /*
      Mirrors the CHECK constraint in migration 0030. Neither is an observation
      of nothing; both would have the building's rollup and the unit's own
      reading counting the same visit twice, which inflates a figure aid
      allocation turns on.
    */
    const level = { level: 'UNSAFE_EVACUATE' };
    expect(createDamageAssessmentSchema.safeParse(level).success).toBe(false);
    expect(
      createDamageAssessmentSchema.safeParse({
        ...level,
        buildingId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        unitId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
      }).success,
    ).toBe(false);
    expect(
      createDamageAssessmentSchema.safeParse({
        ...level,
        buildingId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      }).success,
    ).toBe(true);
  });

  it('allows a back-dated assessment but not a future one', () => {
    // Entered days after the visit, from paper or from a phone that was
    // offline — back-dating is the difference between a history that
    // reconstructs what happened and one that records when the paperwork got
    // typed. The future is the direction that is only ever a typo.
    const base = { level: 'RESTRICTED_USE', buildingId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    expect(createDamageAssessmentSchema.safeParse({ ...base, assessedAt: lastWeek }).success).toBe(
      true,
    );
    expect(createDamageAssessmentSchema.safeParse({ ...base, assessedAt: nextWeek }).success).toBe(
      false,
    );
  });

  it('defaults the source to a field visit', () => {
    const result = createDamageAssessmentSchema.safeParse({
      level: 'NOT_AFFECTED',
      buildingId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.source).toBe('FIELD_VISIT');
  });
});

describe('upsertOccupancySchema', () => {
  const ids = {
    unitId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    citizenId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  };

  it('records أسهم for an owner', () => {
    const result = upsertOccupancySchema.safeParse({ ...ids, role: 'OWNER', shares: 1200 });
    expect(result.success).toBe(true);
  });

  it('refuses أسهم from a tenant', () => {
    // Shares are a fraction of *ownership*. A tenant holding 400 of them is a
    // contradiction, and storing it would corrupt any later sum over the unit.
    const result = upsertOccupancySchema.safeParse({ ...ids, role: 'TENANT', shares: 400 });
    expect(result.success).toBe(false);
  });

  it('refuses a spell that ends before it starts', () => {
    const result = upsertOccupancySchema.safeParse({
      ...ids,
      role: 'TENANT',
      fromDate: '2026-06-01',
      toDate: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  /*
    مساحة الوحدة, accepted here because this is where it is first knowable.

    The matrix is painted from the street — `generateUnits` and the grid picker
    both assert that a flat exists, not that anyone has measured it — so
    `Unit.unitArea` is routinely null, and the card `claimOnFile` mints for the
    citizen inherited that null. Recording an occupant is the first moment
    somebody is actually inside, and the form had nowhere to put the number.

    Accepted of *any* capacity, unlike the two fields above it: a room is the
    same size whoever is standing in it, and a مستأجر with a tape measure knows
    it as well as the owner does.
  */
  it('accepts the flat’s area from whoever is recording the spell', () => {
    for (const role of ['OWNER', 'TENANT', 'FREE_OCCUPANT']) {
      const result = upsertOccupancySchema.safeParse({ ...ids, role, unitArea: 96.5 });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.unitArea).toBe(96.5);
    }
  });

  it('refuses an area of zero, which is a measurement and not an absence', () => {
    /*
      «لم تُقَس» is the omitted field, and the form omits it for an empty box.
      A zero would be stored as a measurement — and then priced at nothing by a
      PER_AREA notice, silently, where a null makes `assessCitizen` refuse to
      price the flat at all and say so.
    */
    expect(upsertOccupancySchema.safeParse({ ...ids, role: 'OWNER', unitArea: 0 }).success).toBe(
      false,
    );

    const omitted = upsertOccupancySchema.safeParse({ ...ids, role: 'OWNER' });
    expect(omitted.success).toBe(true);
    if (!omitted.success) return;
    expect(omitted.data.unitArea).toBeUndefined();
  });
});

describe('buildingFilterSchema', () => {
  it('defaults to a bounded page', () => {
    const result = buildingFilterSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.limit).toBe(100);
    expect(result.data.offset).toBe(0);
  });

  it('composes every filter the ledger offers', () => {
    const result = buildingFilterSchema.safeParse({
      parcelNumber: '1042',
      structureType: 'RESIDENTIAL_BUILDING',
      surveyStatus: 'NOT_SURVEYED',
      damageLevel: 'UNSAFE_EVACUATE',
      search: 'النور',
      limit: '50',
      offset: '100',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.limit).toBe(50);
    expect(result.data.offset).toBe(100);
  });
});
