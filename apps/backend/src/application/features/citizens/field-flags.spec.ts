import {
  adminCreateCitizenSubmissionSchema,
  CADASTRE_UNVERIFIED_REASON,
  cadastreFlags,
  isFlaggablePath,
  statusForFlags,
} from '@mechanization/shared-schemas';

/**
 * «غير مؤكَّد» — what a flag may and may not excuse.
 *
 * These run against the *same schema object* the controller's validation pipe
 * uses and the browser form validates with, so what they pin down is the one
 * contract all three share. That matters more than usual here: a record filed
 * offline is validated in a browser hours before any server sees it, and a
 * browser that accepted something the server would refuse would queue a
 * registration that fails on arrival — in a settlement nobody is going back to.
 */
const complete = () => ({
  personal: {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'نصرالله',
    motherName: 'فاطمة خليل',
    gender: 'MALE',
    bloodType: 'O_POSITIVE',
    identityDocType: 'NATIONAL_ID',
    identityDocNumber: '12345',
    civilRecordNumber: '7',
    nationality: 'لبناني',
    isLebanese: true,
    residentStatus: 'VILLAGE_RESIDENT',
  } as Record<string, unknown>,
  contact: {
    maritalStatus: 'MARRIED',
    phone: '03 123456',
    whatsappSameAsPhone: true,
    totalRegisteredMembers: '4',
    actualHouseholdMembers: '4',
  } as Record<string, unknown>,
  properties: [
    {
      occupancyType: 'OWNER',
      propertyType: 'LAND',
      neighborhood: 'الحي الشرقي',
      propertyNumber: '1553',
      landType: 'AGRICULTURAL',
      unitArea: '250',
      shares: '400',
    } as Record<string, unknown>,
  ],
  flags: [] as Array<{ path: string; reason: string }>,
});

/** The dot-paths a failed parse complained about. */
const failures = (input: unknown): string[] => {
  const result = adminCreateCitizenSubmissionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('citizen submission — no flags', () => {
  it('accepts a complete record and normalises it', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(complete());

    expect(result.success).toBe(true);
    if (!result.success) return;

    // The strict schema's own coercions still happen on the flag-aware path.
    expect(result.data.contact.phone).toBe('+9613123456');
    expect(result.data.contact.totalRegisteredMembers).toBe(4);
    expect(result.data.contact.actualHouseholdMembers).toBe(4);
    expect(result.data.properties[0]?.unitArea).toBe(250);
  });

  it('is exactly as strict as it ever was', () => {
    const input = complete();
    delete input.personal.civilRecordNumber;

    expect(failures(input)).toEqual(['personal.civilRecordNumber']);
  });

  /**
   * فئة الدم is the one question on the personal step whose honest answer is
   * often «لا أعرف». Demanding it produced guesses, so an absent one is
   * accepted with no flag and no «يتطلب مراجعة» — and an empty string, which a
   * select that was opened and closed sends, arrives as an absence rather than
   * as a value the enum column could not store.
   */
  it('accepts a record with no blood type, unflagged', () => {
    const input = complete();
    delete input.personal.bloodType;

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.personal.bloodType).toBeUndefined();
    expect(statusForFlags(result.data.flags)).not.toBe('REQUIRES_REVIEW');
  });

  it('normalises an empty blood type to an absence', () => {
    const input = complete();
    input.personal.bloodType = '';

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);

    expect(result.success).toBe(true);
    expect(result.data!.personal.bloodType).toBeUndefined();
  });
});

/**
 * The two fields gated on occupancy rather than on property type.
 *
 * Both travel through `branchFieldsOnly`, which filters a card down to its
 * branch before the partial schemas coerce it — and `PROPERTY_FIELD_MAP`, being
 * keyed by نوع العقار, cannot describe either of them. A field missing from
 * that filter is not rejected; it is silently dropped on the way to storage,
 * which is the failure worth a test rather than a comment.
 */
describe('citizen submission — occupancy-gated fields', () => {
  const ownedHouse = (extra: Record<string, unknown> = {}) => {
    const input = complete();
    input.properties = [
      {
        occupancyType: 'OWNER',
        propertyType: 'HOUSE',
        neighborhood: 'الحي الشرقي',
        propertyNumber: '1553',
        buildingName: 'دار المراد',
        unitArea: '140',
        ...extra,
      } as Record<string, unknown>,
    ];
    return input;
  };

  it('keeps حالة الوحدة on an owner-filed house', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(
      ownedHouse({ unitStatus: 'VACANT' }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.properties[0]?.unitStatus).toBe('VACANT');
  });

  it('does not require one', () => {
    // Optional everywhere it appears, so a card without it is complete and a
    // clerk is never blocked on a question they could not answer.
    expect(failures(ownedHouse())).toEqual([]);
  });

  it('accepts a free occupant who names the owner but has no number for them', () => {
    const input = complete();
    input.properties = [
      {
        occupancyType: 'FREE_OCCUPANT',
        landlordName: 'أبو خالد',
        propertyType: 'HOUSE',
        neighborhood: 'الحي الشرقي',
        propertyNumber: '1553',
        buildingName: 'دار المراد',
        unitArea: '140',
      } as Record<string, unknown>,
    ];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.properties[0]?.landlordName).toBe('أبو خالد');
    expect(result.data.properties[0]?.landlordPhone).toBeUndefined();
  });

  it('still demands the owner’s name from one', () => {
    const input = complete();
    input.properties = [
      {
        occupancyType: 'FREE_OCCUPANT',
        propertyType: 'HOUSE',
        neighborhood: 'الحي الشرقي',
        propertyNumber: '1553',
        buildingName: 'دار المراد',
        unitArea: '140',
      } as Record<string, unknown>,
    ];

    expect(failures(input)).toEqual(['properties.0.landlordName']);
  });

  it('still demands both from a tenant', () => {
    const input = complete();
    input.properties = [
      {
        occupancyType: 'TENANT',
        landlordName: 'سمير مراد',
        propertyType: 'HOUSE',
        neighborhood: 'الحي الشرقي',
        propertyNumber: '1553',
        buildingName: 'دار المراد',
        unitArea: '140',
      } as Record<string, unknown>,
    ];

    expect(failures(input)).toEqual(['properties.0.landlordPhone']);
  });
});

describe('citizen submission — a flag excuses one field', () => {
  it('accepts a missing field the officer flagged, with the reason', () => {
    const input = complete();
    delete input.personal.civilRecordNumber;
    input.flags = [
      { path: 'personal.civilRecordNumber', reason: 'إخراج القيد عند الأخ في بيروت' },
    ];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.personal.civilRecordNumber).toBeUndefined();
    expect(statusForFlags(result.data.flags)).toBe('REQUIRES_REVIEW');
  });

  it('does not excuse the field next to it', () => {
    const input = complete();
    delete input.personal.civilRecordNumber;
    delete input.personal.motherName;
    input.flags = [{ path: 'personal.civilRecordNumber', reason: 'إخراج القيد عند الأخ' }];

    expect(failures(input)).toEqual(['personal.motherName']);
  });

  it('does not excuse the same field on a different property card', () => {
    const input = complete();
    input.properties = [
      { ...input.properties[0] },
      { ...input.properties[0], propertyNumber: '1554' },
    ];
    delete input.properties[0]!.unitArea;
    delete input.properties[1]!.unitArea;
    input.flags = [{ path: 'properties.0.unitArea', reason: 'الأرض غير ممسوحة' }];

    expect(failures(input)).toEqual(['properties.1.unitArea']);
  });

  it('discards a value the officer flagged rather than storing it', () => {
    // The officer typed a guess, then flagged the field. The guess must not
    // survive: the record says this was never established.
    const input = complete();
    input.properties[0]!.propertyNumber = '9999';
    input.flags = [{ path: 'properties.0.propertyNumber', reason: 'السند عند الورثة' }];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.properties[0]?.propertyNumber).toBeUndefined();
  });

  it('requires a reason worth reading', () => {
    const input = complete();
    delete input.personal.civilRecordNumber;
    input.flags = [{ path: 'personal.civilRecordNumber', reason: '' }];

    expect(failures(input)).toEqual(['flags.0.reason']);
  });

  it('refuses a flag on a field the record cannot do without', () => {
    const input = complete();
    delete input.personal.lastName;
    input.flags = [{ path: 'personal.lastName', reason: 'لم يُذكر' }];

    // Refused as a flag, not merely ignored — an officer who is told "flagged"
    // and then finds the save rejected on الشهرة has been misled twice.
    expect(failures(input)).toEqual(['flags.0.path']);
    expect(isFlaggablePath('personal.lastName')).toBe(false);
    expect(isFlaggablePath('properties.0.propertyType')).toBe(false);
    expect(isFlaggablePath('properties.0.propertyNumber')).toBe(true);
  });

  it('refuses the same field flagged twice', () => {
    const input = complete();
    delete input.personal.civilRecordNumber;
    input.flags = [
      { path: 'personal.civilRecordNumber', reason: 'سبب أول' },
      { path: 'personal.civilRecordNumber', reason: 'سبب ثانٍ' },
    ];

    expect(failures(input)).toEqual(['flags.1.path']);
  });
});


/**
 * Per-unit flags — a stairwell where nine flats answered and the tenth did not.
 *
 * The only building-level flag that existed was on the whole `units` array:
 * «we could not go through the building». That is a real afternoon and the
 * control is still there for it, but it was also the *only* thing anybody could
 * say — so a building where one flat did not answer had to be filed either as
 * complete, with an invented tenth unit, or as a building nobody entered.
 *
 * These run against the same schema object the controller's pipe and the
 * browser form use, which is what makes them worth writing at this level: a
 * record filed offline is validated in a browser hours before a server sees it,
 * and a browser that accepted what the server refuses queues a registration
 * that fails on arrival in a settlement nobody is going back to.
 */
describe('citizen submission — per-unit flags', () => {
  const building = (units: Array<Record<string, unknown>>) => {
    const input = complete();
    input.properties = [
      {
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي الشرقي',
        propertyNumber: '1553',
        buildingName: 'بناية النور',
        units,
      } as Record<string, unknown>,
    ];
    return input;
  };

  const unit = (extra: Record<string, unknown> = {}) => ({
    unitType: 'APARTMENT',
    floor: '3',
    unitArea: '120',
    ...extra,
  });

  it('accepts a per-unit path as flaggable', () => {
    expect(isFlaggablePath('properties.0.units.3.unitArea')).toBe(true);
    expect(isFlaggablePath('properties.0.units.0.floor')).toBe(true);
    // The whole-array flag it never replaced.
    expect(isFlaggablePath('properties.0.units')).toBe(true);
  });

  it('still refuses a path no input can resolve to', () => {
    expect(isFlaggablePath('properties.0.units.3')).toBe(false);
    expect(isFlaggablePath('properties.0.units.unitArea')).toBe(false);
    expect(isFlaggablePath('properties.0.units.3.sharedRights.0')).toBe(false);
    expect(isFlaggablePath('units.3.unitArea')).toBe(false);
  });

  it('excuses the one unit field the officer flagged', () => {
    const input = building([unit(), unit({ unitArea: undefined, floor: '4' })]);
    input.flags = [
      { path: 'properties.0.units.1.unitArea', reason: 'الشقة مقفلة ولم نتمكن من القياس' },
    ];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The building is still here, with both flats. Before this the record's
    // only options were an invented area or no building at all.
    expect(result.data.properties[0]?.units).toHaveLength(2);
    expect(result.data.properties[0]?.units?.[0]?.unitArea).toBe(120);
    expect(result.data.properties[0]?.units?.[1]?.unitArea).toBeUndefined();
    expect(statusForFlags(result.data.flags)).toBe('REQUIRES_REVIEW');
  });

  it('does not excuse the same field on the unit next to it', () => {
    const input = building([unit({ unitArea: undefined }), unit({ unitArea: undefined })]);
    input.flags = [{ path: 'properties.0.units.0.unitArea', reason: 'الشقة مقفلة' }];

    expect(failures(input)).toEqual(['properties.0.units.1.unitArea']);
  });

  it('does not excuse a different field on the same unit', () => {
    const input = building([unit({ unitArea: undefined, floor: undefined })]);
    input.flags = [{ path: 'properties.0.units.0.unitArea', reason: 'الشقة مقفلة' }];

    expect(failures(input)).toEqual(['properties.0.units.0.floor']);
  });

  it('does not excuse a unit on a different property card', () => {
    const input = building([unit({ unitArea: undefined })]);
    input.properties.push({
      ...(input.properties[0] as Record<string, unknown>),
      propertyNumber: '1554',
    });
    input.flags = [{ path: 'properties.0.units.0.unitArea', reason: 'الشقة مقفلة' }];

    expect(failures(input)).toEqual(['properties.1.units.0.unitArea']);
  });

  it('discards a value the officer flagged rather than storing it', () => {
    // The officer estimated an area, then flagged it. The estimate must not
    // survive: the record says this was never established.
    const input = building([unit({ unitArea: '999' })]);
    input.flags = [{ path: 'properties.0.units.0.unitArea', reason: 'تقدير بالنظر فقط' }];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.properties[0]?.units?.[0]?.unitArea).toBeUndefined();
  });

  it('leaves the whole-array flag doing exactly what it did', () => {
    // «we could not go through the building at all» — the units are gone, and
    // the per-unit walk has nothing to descend into.
    const input = building([]);
    delete (input.properties[0] as Record<string, unknown>).units;
    input.flags = [{ path: 'properties.0.units', reason: 'الدرج مقفل والناطور غائب' }];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.properties[0]?.units).toBeUndefined();
  });

  it('shapes a flagged card instead of throwing on the way to storage', () => {
    /*
      The failure this is really about.

      `unexcusedIssues` and `shapeSubmission` are two passes over one record: the
      first decides the flags account for every complaint, the second coerces
      what survived. They have to agree about a blanked unit field — a strict
      unit schema on the second pass would refuse a card the first had already
      accepted, and a `.parse` there throws rather than returning an error, so
      the request would 500 instead of validating.
    */
    const input = building([unit({ unitArea: undefined, floor: undefined, unitType: undefined })]);
    input.flags = [
      { path: 'properties.0.units.0.unitArea', reason: 'الشقة مقفلة' },
      { path: 'properties.0.units.0.floor', reason: 'لم نصعد الطوابق' },
      { path: 'properties.0.units.0.unitType', reason: 'لم نتمكن من المعاينة' },
    ];

    expect(() => adminCreateCitizenSubmissionSchema.parse(input)).not.toThrow();
  });

  it('still coerces the units it kept', () => {
    const input = building([unit({ unitArea: '85.5', sharedRights: ['مصعد'] })]);

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.properties[0]?.units?.[0]?.unitArea).toBe(85.5);
    expect(result.data.properties[0]?.units?.[0]?.sharedRights).toEqual(['مصعد']);
  });

  it('refuses the same unit field flagged twice', () => {
    const input = building([unit({ unitArea: undefined })]);
    input.flags = [
      { path: 'properties.0.units.0.unitArea', reason: 'سبب أول' },
      { path: 'properties.0.units.0.unitArea', reason: 'سبب ثانٍ' },
    ];

    expect(failures(input)).toEqual(['flags.1.path']);
  });
});
describe('citizen submission — cross-field rules', () => {
  it('still refuses a tent for someone who is not a refugee', () => {
    const input = complete();
    input.properties = [
      {
        occupancyType: 'OWNER',
        propertyType: 'TENT',
        neighborhood: 'المخيم',
        propertyNumber: '9',
        tentLocation: 'قطعة ٤ شمال',
      },
    ];

    expect(failures(input)).toEqual(['properties.0.propertyType']);
  });

  it('allows the tent once صفة الإقامة itself is what could not be established', () => {
    // Refusing here would turn a flag on one field into a rejection of another.
    const input = complete();
    delete input.personal.residentStatus;
    input.properties = [
      {
        occupancyType: 'OWNER',
        propertyType: 'TENT',
        neighborhood: 'المخيم',
        propertyNumber: '9',
        tentLocation: 'قطعة ٤ شمال',
      },
    ];
    input.flags = [{ path: 'personal.residentStatus', reason: 'لا وثائق إقامة اليوم' }];

    expect(failures(input)).toEqual([]);
  });

  it('keeps a household with no phone reachable by nothing, and says so', () => {
    const input = complete();
    delete input.contact.phone;
    input.flags = [{ path: 'contact.phone', reason: 'الأسرة بلا هاتف' }];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // `whatsappSameAsPhone` is still true, and there is nothing to copy — so
    // both come back empty rather than one of them inventing the other.
    expect(result.data.contact.phone).toBeUndefined();
    expect(result.data.contact.whatsapp).toBeUndefined();
  });
});

describe('citizen submission — offline delivery', () => {
  it('carries the browser id that makes a retry safe to repeat', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse({
      ...complete(),
      clientSubmissionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.clientSubmissionId).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('leaves a record with nothing flagged as an ordinary registration', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(complete());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(statusForFlags(result.data.flags)).toBe('PENDING');
  });
});

/**
 * The two flag kinds, and the wall between them.
 *
 * `UNESTABLISHED` blanks a field and excuses the strict schema's complaint
 * about it. `UNVERIFIED` does neither — it annotates a value that is present
 * and must still be valid. Everything below exists because letting one behave
 * like the other is silent data loss in one direction and silent validation
 * loss in the other.
 */
describe('citizen submission — recorded-but-unverified fields', () => {
  it('never blanks a field an UNVERIFIED flag names', () => {
    const input = complete();
    input.flags = [
      {
        path: 'properties.0.propertyNumber',
        reason: CADASTRE_UNVERIFIED_REASON,
        kind: 'UNVERIFIED',
      },
    ] as never;

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);

    expect(result.success).toBe(true);
    // The number the officer read off the deed survives the round trip; the
    // whole reason this kind exists is that erasing it destroys the best
    // information anyone has about the household.
    expect(result.data!.properties[0]!.propertyNumber).toBe('1553');
  });

  it('does not let an UNVERIFIED flag excuse a field that is actually missing', () => {
    const input = complete();
    delete input.properties[0]!.propertyNumber;
    input.flags = [
      { path: 'properties.0.propertyNumber', reason: 'غير مؤكد حالياً', kind: 'UNVERIFIED' },
    ] as never;

    // An UNVERIFIED flag is a note about a value, not a waiver. With the value
    // gone the strict schema's complaint stands.
    expect(failures(input)).toContain('properties.0.propertyNumber');
  });

  it('discards an UNVERIFIED flag sent by a client', () => {
    const input = complete();
    input.flags = [
      { path: 'personal.motherName', reason: 'لا يهم', kind: 'UNVERIFIED' },
    ] as never;

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);

    expect(result.success).toBe(true);
    // Only something holding the municipality's records may assert this, so a
    // browser's copy is dropped rather than stored or trusted.
    expect(result.data!.flags).toEqual([]);
  });

  it('treats a flag with no kind as the officer own — every stored row predates the split', () => {
    const input = complete();
    delete input.personal.motherName;
    input.flags = [{ path: 'personal.motherName', reason: 'الأهل غير متواجدين' }];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);

    expect(result.success).toBe(true);
    expect(result.data!.flags[0]!.kind).toBe('UNESTABLISHED');
  });
});

describe('cadastre notes', () => {
  const cards = [{ propertyNumber: '1553' }, { propertyNumber: '9999' }];

  it('annotates only the card whose number the cadastre does not have', () => {
    const flags = cadastreFlags(cards, new Set(['9999']));

    expect(flags).toEqual([
      {
        path: 'properties.1.propertyNumber',
        reason: CADASTRE_UNVERIFIED_REASON,
        kind: 'UNVERIFIED',
      },
    ]);
  });

  it('says nothing when the municipality has no cadastre to check against', () => {
    expect(cadastreFlags(cards, new Set())).toEqual([]);
  });

  it('leaves a number the officer already flagged alone', () => {
    // The field has no value to be unconfirmed about, and two flags on one
    // path is a contradiction the storage cannot express.
    const flags = cadastreFlags([{ propertyNumber: undefined }], new Set(['9999']), [
      { path: 'properties.0.propertyNumber', reason: 'السند غير متوفر', kind: 'UNESTABLISHED' },
    ]);

    expect(flags).toEqual([]);
  });

  it('holds a record for review on the strength of a cadastre note alone', () => {
    expect(
      statusForFlags([
        {
          path: 'properties.0.propertyNumber',
          reason: CADASTRE_UNVERIFIED_REASON,
          kind: 'UNVERIFIED',
        },
      ]),
    ).toBe('REQUIRES_REVIEW');
  });
});
