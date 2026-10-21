import { describe, expect, it } from 'vitest';
import { CEILING_MAX, ceilingChange, ceilingDraft, ceilingToSend, ceilingValue } from './urgent-ceiling';

describe('ceilingDraft', () => {
  it('shows no ceiling as an empty field, and a ceiling grouped', () => {
    expect(ceilingDraft(null, 0)).toBe('');
    expect(ceilingDraft(undefined, 2)).toBe('');
    expect(ceilingDraft(5000000, 0)).toBe('5,000,000');
  });
});

describe('ceilingValue', () => {
  it('reads an empty field as no ceiling, and a figure as itself', () => {
    expect(ceilingValue('')).toBeNull();
    expect(ceilingValue('  ')).toBeNull();
    expect(ceilingValue('5,000,000')).toBe(5000000);
  });

  it('refuses zero and a figure the column cannot hold', () => {
    expect(ceilingValue('0')).toBeUndefined();
    expect(ceilingValue(String(CEILING_MAX + 1))).toBeUndefined();
  });
});

describe('ceilingChange and ceilingToSend', () => {
  it('sends nothing for a field left as it was read', () => {
    // A save about the exchange rate must not rewrite the ceiling.
    const change = ceilingChange('5,000,000', '5,000,000');
    expect(change).toEqual({ kind: 'unchanged' });
    expect(ceilingToSend(change)).toBeUndefined();
  });

  it('never rounds a stored fractional ceiling it did not change', () => {
    // 1,234,567.5 ل.ل. stored: the LBP field shows it rounded, and an untouched field sends nothing.
    const shown = ceilingDraft(1234567.5, 0);
    expect(ceilingToSend(ceilingChange(shown, shown))).toBeUndefined();
  });

  it('sends a changed figure, and an emptied field as no ceiling', () => {
    expect(ceilingToSend(ceilingChange('7,500,000', '5,000,000'))).toBe(7500000);
    expect(ceilingToSend(ceilingChange('', '5,000,000'))).toBeNull();
    expect(ceilingToSend(ceilingChange('250.00', ''))).toBe(250);
  });

  it('calls a changed field that is not a ceiling invalid, and sends nothing for it', () => {
    const change = ceilingChange('0', '5,000,000');
    expect(change).toEqual({ kind: 'invalid' });
    expect(ceilingToSend(change)).toBeUndefined();
  });

  it('judges every field as changed when the settings were never read', () => {
    expect(ceilingChange('', undefined)).toEqual({ kind: 'set', value: null });
    expect(ceilingChange('100', undefined)).toEqual({ kind: 'set', value: 100 });
  });
});
