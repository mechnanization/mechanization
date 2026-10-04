import { ReferenceNumber } from './reference-number.vo';

describe('ReferenceNumber.mask', () => {
  it('keeps the municipality and the issue month, and hides the whole secret suffix', () => {
    expect(ReferenceNumber.mask('BZR-2607-4K9QX2')).toBe('BZR-2607-••••••');
  });

  it('reveals not one character of the suffix', () => {
    const reference = ReferenceNumber.generate('BZR').value;
    const suffix = reference.slice(-6);
    const masked = ReferenceNumber.mask(reference)!;

    expect(masked.endsWith('••••••')).toBe(true);
    for (const char of new Set(suffix)) {
      expect(masked.slice(9)).not.toContain(char);
    }
  });

  it('reads what a citizen types, and hides anything that is not a reference whole', () => {
    expect(ReferenceNumber.mask(' bzr-2607-4k9qx2 ')).toBe('BZR-2607-••••••');
    expect(ReferenceNumber.mask('not-a-reference')).toBe('••••••');
  });

  it('has nothing to mask for no reference', () => {
    expect(ReferenceNumber.mask(null)).toBeNull();
    expect(ReferenceNumber.mask('')).toBeNull();
  });
});
