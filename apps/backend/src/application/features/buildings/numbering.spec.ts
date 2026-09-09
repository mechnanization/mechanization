import {
  buildingSuffixAt,
  formatBuildingCode,
  formatFullUnitReference,
  formatUnitCode,
  nextBuildingSuffix,
  parseFloorLabel,
} from '@mechanization/shared-schemas';

/**
 * The municipality's numbering, pinned.
 *
 * `parseFloorLabel` is the one that earns the most of these cases. It is a
 * one-way door from a free-text column an officer typed on a phone into an
 * `Int` a census can sort, count and put on a map — so every wrong answer is
 * either a flat filed on the wrong floor or a flat that disappears, and both
 * are silent. The distinct values actually in the staging database today are
 * `"0"`, `"1"` and `"2"`, which prove nothing at all; the cases below are the
 * shapes a text input in an Arabic-first RTL form produces.
 */
describe('parseFloorLabel — the ordinary numeric cases', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['12', 12],
    ['-1', -1],
    ['-2', -2],
    [' 3 ', 3],
  ])('reads %j as floor %i', (label, expected) => {
    expect(parseFloorLabel(label)).toBe(expected);
  });

  it('reads Arabic-Indic digits, which an Arabic keyboard produces by default', () => {
    expect(parseFloorLabel('٣')).toBe(3);
    expect(parseFloorLabel('١٢')).toBe(12);
    expect(parseFloorLabel('الطابق ٤')).toBe(4);
  });

  it('reads a number carried on a label', () => {
    expect(parseFloorLabel('ط1')).toBe(1);
    expect(parseFloorLabel('طابق 5')).toBe(5);
    expect(parseFloorLabel('الطابق 7')).toBe(7);
    expect(parseFloorLabel('2nd floor')).toBe(2);
  });

  it('treats a spaced dash as a separator, not a sign', () => {
    // «طابق - 1» is how a label is punctuated, not how a basement is written.
    // The sign is only read when it is attached to the digits.
    expect(parseFloorLabel('طابق - 1')).toBe(1);
    expect(parseFloorLabel('طابق -1')).toBe(-1);
  });
});

describe('parseFloorLabel — the ground floor, however it is written', () => {
  it.each(['الأرضي', 'الارضي', 'ارضي', 'الطابق الأرضي', 'ground', 'Ground Floor', 'G', 'GF', '0'])(
    'reads %j as 0',
    (label) => {
      expect(parseFloorLabel(label)).toBe(0);
    },
  );

  it('does not read «الأرضي» as «الأول» — the alef fold must not reach the ordinals', () => {
    expect(parseFloorLabel('الأرضي')).toBe(0);
    expect(parseFloorLabel('الأول')).toBe(1);
  });
});

describe('parseFloorLabel — basements', () => {
  it('reads a basement named without a number as the first one down', () => {
    expect(parseFloorLabel('قبو')).toBe(-1);
    expect(parseFloorLabel('القبو')).toBe(-1);
    expect(parseFloorLabel('basement')).toBe(-1);
    expect(parseFloorLabel('سرداب')).toBe(-1);
  });

  it('takes the depth from the number when there is one', () => {
    // The word changes the *sign* of a number that is also present, which is
    // why basements are tested before anything numeric.
    expect(parseFloorLabel('قبو 2')).toBe(-2);
    expect(parseFloorLabel('basement 3')).toBe(-3);
    expect(parseFloorLabel('B1')).toBe(-1);
    expect(parseFloorLabel('b2')).toBe(-2);
  });

  it('does not read «تحت الأرض» as the ground floor', () => {
    expect(parseFloorLabel('تحت الأرض')).toBe(-1);
  });
});

describe('parseFloorLabel — Arabic ordinals', () => {
  it.each([
    ['الأول', 1],
    ['الطابق الثاني', 2],
    ['الثالث', 3],
    ['الرابع', 4],
    ['الخامس', 5],
    ['السادس', 6],
    ['السابع', 7],
    ['الثامن', 8],
    ['التاسع', 9],
    ['العاشر', 10],
  ])('reads %j as floor %i', (label, expected) => {
    expect(parseFloorLabel(label)).toBe(expected);
  });

  it('reads a compound ordinal as the compound, not its first word', () => {
    // «الثاني عشر» contains «الثاني». Testing the singles first would file the
    // twelfth floor as the second, which is the whole reason the list is
    // ordered longest-compound-first.
    expect(parseFloorLabel('الثاني عشر')).toBe(12);
    expect(parseFloorLabel('الحادي عشر')).toBe(11);
    expect(parseFloorLabel('الثالث عشر')).toBe(13);
  });
});

describe('parseFloorLabel — what it refuses', () => {
  it('returns null rather than guessing a floor', () => {
    // A mezzanine and a roof are real places an integer cannot name. Guessing 0
    // for either would file a shop in the wrong flat with nothing to say so;
    // null sends the row to the review the backfill reports.
    expect(parseFloorLabel('ميزانين')).toBeNull();
    expect(parseFloorLabel('السطح')).toBeNull();
    expect(parseFloorLabel('غير معروف')).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(parseFloorLabel('')).toBeNull();
    expect(parseFloorLabel('   ')).toBeNull();
    expect(parseFloorLabel(null)).toBeNull();
    expect(parseFloorLabel(undefined)).toBeNull();
  });

  it('refuses a number no building has', () => {
    // The column is free text, so it also holds years, areas and phone numbers
    // somebody typed in the wrong box. A "floor" of 2024 is not a floor.
    expect(parseFloorLabel('2024')).toBeNull();
    expect(parseFloorLabel('-99')).toBeNull();
    expect(parseFloorLabel('100')).toBe(100);
  });
});

describe('formatUnitCode', () => {
  it.each([
    [0, 1, '0001'],
    [1, 2, '0102'],
    [3, 4, '0304'],
    [12, 1, '1201'],
    [-1, 2, 'B102'],
    [-2, 1, 'B201'],
  ])('floor %i unit %i is %s', (floor, sequence, expected) => {
    expect(formatUnitCode(floor, sequence)).toBe(expected);
  });

  it('is self-describing — the floor reads straight off the code', () => {
    // The point of the format: a collector on foot knows which floor to climb
    // to without opening the app.
    expect(formatUnitCode(7, 3).slice(0, 2)).toBe('07');
  });
});

describe('buildingSuffixAt / nextBuildingSuffix', () => {
  it('skips I and O', () => {
    // Both read as digits painted on a wall, next to a parcel number that is
    // itself numeric — so the ambiguity resolves the wrong way about half the
    // time.
    const first24 = Array.from({ length: 24 }, (_, i) => buildingSuffixAt(i));
    expect(first24.join('')).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ');
    expect(first24).not.toContain('I');
    expect(first24).not.toContain('O');
  });

  it('continues past Z with no gap and no zero digit', () => {
    expect(buildingSuffixAt(23)).toBe('Z');
    expect(buildingSuffixAt(24)).toBe('AA');
    expect(buildingSuffixAt(25)).toBe('AB');
    expect(buildingSuffixAt(24 + 24)).toBe('BA');
  });

  it('refuses a negative or fractional index rather than inventing a suffix', () => {
    expect(() => buildingSuffixAt(-1)).toThrow(RangeError);
    expect(() => buildingSuffixAt(1.5)).toThrow(RangeError);
  });

  it('hands the first free suffix to a fresh parcel', () => {
    expect(nextBuildingSuffix([])).toBe('A');
    expect(nextBuildingSuffix(['A'])).toBe('B');
    expect(nextBuildingSuffix(['A', 'B', 'C'])).toBe('D');
  });

  it('fills a hole rather than counting the rows', () => {
    // A parcel whose B was deleted gets B back. Counting would hand out C and
    // leave a permanent gap — and, worse, would hand the same "count + 1" to
    // two callers looking at the parcel at once.
    expect(nextBuildingSuffix(['A', 'C'])).toBe('B');
  });

  it('is case-insensitive about what is already taken', () => {
    expect(nextBuildingSuffix(['a', ' b '])).toBe('C');
  });
});

describe('formatBuildingCode', () => {
  it('delimits the three parts', () => {
    expect(
      formatBuildingCode({ zoneCode: 'A', parcelNumber: '1042', codeSuffix: 'B' }),
    ).toBe('A-1042-B');
  });

  it('renders a parcel in no zone as X', () => {
    // A statement — this parcel has not been assigned to a sector — rather than
    // a blank that reads as a bug.
    expect(formatBuildingCode({ parcelNumber: '1042', codeSuffix: 'A' })).toBe('X-1042-A');
    expect(formatBuildingCode({ zoneCode: null, parcelNumber: '1042', codeSuffix: 'A' })).toBe(
      'X-1042-A',
    );
    expect(formatBuildingCode({ zoneCode: '  ', parcelNumber: '1042', codeSuffix: 'A' })).toBe(
      'X-1042-A',
    );
  });

  it('normalises case so one building cannot hold two codes', () => {
    expect(
      formatBuildingCode({ zoneCode: 'sec-a1', parcelNumber: ' 1042 ', codeSuffix: 'b' }),
    ).toBe('SEC-A1-1042-B');
  });

  it('composes the full unit reference', () => {
    expect(formatFullUnitReference('A-1042-B', '0304')).toBe('A-1042-B-0304');
  });
});
