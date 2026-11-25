import { describe, expect, it } from 'vitest';
import { completeTime, latinDigits, normalizeTime, stepTime, typedTime } from './time-input';

/*
  U-8 (decided 2026-11-25): the kit's time field. These are its rules, as tables: what a box shows while a time
  is typed, what a half-typed one means when the field is left, and where an arrow moves. The component that
  draws them is `components/ui/time-picker.tsx`, driven in `time-picker-dom.test.ts`.
*/
describe('latinDigits', () => {
  it('reads the digits an Arabic keyboard types as Latin ones, both sets', () => {
    expect(latinDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(latinDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(latinDigits('٠٩:٣٠')).toBe('09:30');
  });

  it('leaves everything else alone', () => {
    expect(latinDigits('ab:12 ص')).toBe('ab:12 ص');
  });
});

describe('completeTime', () => {
  it.each(['00:00', '09:30', '19:05', '23:59'])('accepts %s', (text) => {
    expect(completeTime(text)).toBe(text);
  });

  it.each(['', '9:30', '09:3', '24:00', '12:60', '0930', '09:30 ', 'ab:cd'])('refuses "%s", guessing nothing', (text) => {
    expect(completeTime(text)).toBeNull();
  });
});

describe('typedTime: what the box shows while a time is typed', () => {
  it.each([
    ['', ''],
    ['9', '9'],
    ['09', '09'],
    ['93', '09:3'],
    ['930', '09:30'],
    ['9300', '09:30'],
    ['1', '1'],
    ['19', '19'],
    ['193', '19:3'],
    ['1930', '19:30'],
    ['2', '2'],
    ['23', '23'],
    ['235', '23:5'],
    ['2359', '23:59'],
    // a 2 followed by 4 to 9 cannot be a two-digit hour
    ['25', '02:5'],
    ['255', '02:55'],
    // a colon, typed or already there
    ['9:', '9:'],
    ['9:30', '9:30'],
    ['09:30', '09:30'],
    ['09:', '09:'],
    ['09:30:15', '09:30'],
    // what is not a digit or a colon is dropped
    ['ab9', '9'],
    ['09 30', '09:30'],
    ['٠٩٣٠', '09:30'],
    ['۰۹:۳۰', '09:30'],
    ['123456', '12:34'],
  ])('"%s" shows as "%s"', (typed, shown) => {
    expect(typedTime(typed)).toBe(shown);
  });

  it('never grows past five characters', () => {
    for (const text of ['11111111', '09:30:30:30', '٠٩٣٠٠٠٠']) expect(typedTime(text).length).toBeLessThanOrEqual(5);
  });
});

describe('normalizeTime: what a text means when the field is left', () => {
  it.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['19', '19:00'],
    ['930', '09:30'],
    ['0930', '09:30'],
    ['1930', '19:30'],
    ['9:30', '09:30'],
    ['09:30', '09:30'],
    [' 14:05 ', '14:05'],
    ['٠٩:٣٠', '09:30'],
    ['0', '00:00'],
    ['2359', '23:59'],
  ])('"%s" is %s', (text, time) => {
    expect(normalizeTime(text)).toBe(time);
  });

  it.each([
    '',
    '   ',
    '9:5', // 09:05 or 09:50: not guessed
    '9:',
    ':30',
    '24:00',
    '2400',
    '25',
    '12:60',
    '1260',
    '12345',
    'ab',
    '09:30:15',
  ])('"%s" is not a time', (text) => {
    expect(normalizeTime(text)).toBeNull();
  });
});

describe('stepTime: where an arrow moves', () => {
  const START = '09:00';

  it('opens an empty field on the start time, in either direction', () => {
    expect(stepTime(null, 1, 5, START)).toBe('09:00');
    expect(stepTime(null, -1, 5, START)).toBe('09:00');
  });

  it.each([
    ['14:30', 1, '14:35'],
    ['14:30', -1, '14:25'],
    // off the grid, to the grid line in the direction pressed
    ['14:32', 1, '14:35'],
    ['14:32', -1, '14:30'],
    ['14:01', -1, '14:00'],
    ['14:59', 1, '15:00'],
  ] as const)('%s by 5, direction %i, is %s', (from, direction, to) => {
    expect(stepTime(from, direction, 5, START)).toBe(to);
  });

  it('wraps past midnight, both ways', () => {
    expect(stepTime('23:58', 1, 5, START)).toBe('00:00');
    expect(stepTime('23:55', 1, 5, START)).toBe('00:00');
    expect(stepTime('00:00', -1, 5, START)).toBe('23:55');
    expect(stepTime('00:02', -1, 5, START)).toBe('00:00');
  });

  it('moves an hour at 60, which is what Shift asks for', () => {
    expect(stepTime('14:30', 1, 60, START)).toBe('15:00');
    expect(stepTime('14:00', 1, 60, START)).toBe('15:00');
    expect(stepTime('14:00', -1, 60, START)).toBe('13:00');
    expect(stepTime('00:30', -1, 60, START)).toBe('00:00');
    expect(stepTime('23:30', 1, 60, START)).toBe('00:00');
  });

  it('only ever gives a complete time', () => {
    for (let minute = 0; minute < 1440; minute += 7) {
      const from = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      for (const direction of [1, -1] as const) {
        expect(completeTime(stepTime(from, direction, 5, START)), `${from} ${direction}`).not.toBeNull();
      }
    }
  });
});
