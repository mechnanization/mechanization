import { describe, expect, it } from 'vitest';
import { carryHeldPhone, namesAnotherRelative, samePhone } from './citizen-contact';

describe('samePhone', () => {
  it('reads one number however it was typed', () => {
    expect(samePhone('03 123 456', '+9613123456')).toBe(true);
    expect(samePhone('٠٣١٢٣٤٥٦', '3123456')).toBe(true);
    expect(samePhone('03123456', '71123456')).toBe(false);
  });

  it('compares a half-typed number as typed', () => {
    expect(samePhone('0312', '0312')).toBe(true);
    expect(samePhone('0312', '03123456')).toBe(false);
  });
});

describe('carryHeldPhone — «لا يملك رقم هاتف» keeps the number on the file', () => {
  const before = { phone: '03123456', hasNoPhone: false };

  it('moves the number into «رقم للتواصل» on the tick', () => {
    expect(carryHeldPhone(before, { phone: '', hasNoPhone: true })).toEqual({
      phone: '',
      hasNoPhone: true,
      contactPhone: '03123456',
    });
  });

  it('never writes over a relative the officer already named', () => {
    const next = { phone: '', hasNoPhone: true, contactPhone: '71123456' };
    expect(carryHeldPhone(before, next)).toBe(next);
  });

  it('does nothing when there was no number, or on any change but the tick', () => {
    const blank = { phone: '  ', hasNoPhone: false };
    const ticked = { phone: '', hasNoPhone: true };
    expect(carryHeldPhone(blank, ticked)).toBe(ticked);
    const typing = { phone: '0312345', hasNoPhone: false };
    expect(carryHeldPhone(before, typing)).toBe(typing);
  });

  it('does not move it back when the box is unticked', () => {
    const unticked = { phone: '', hasNoPhone: false, contactPhone: '03123456' };
    expect(carryHeldPhone({ phone: '', hasNoPhone: true, contactPhone: '03123456' }, unticked)).toBe(unticked);
  });
});

describe('namesAnotherRelative', () => {
  it('is false with no «رقم للتواصل», or when it is the typed phone', () => {
    expect(namesAnotherRelative({ phone: '03123456' })).toBe(false);
    expect(namesAnotherRelative({ phone: '03123456', contactPhone: ' ' })).toBe(false);
    expect(namesAnotherRelative({ phone: '03123456', contactPhone: '+961 3 123 456' })).toBe(false);
  });

  it('is true when the file names a different relative', () => {
    expect(namesAnotherRelative({ phone: '03123456', contactPhone: '71123456' })).toBe(true);
    expect(namesAnotherRelative({ phone: '', contactPhone: '71123456' })).toBe(true);
  });
});
