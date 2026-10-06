import { ReferenceNumber } from './reference-number.vo';

/*
  «مشاهد فقط» is never shown a رقم مرجعي, and the interceptor masks one inside any string by
  its pattern. The reference-only sign-in accepts it lower case and spaced, so a
  note or a search echo can carry it that way; those are masked too.
*/
describe('ReferenceNumber.maskWithin', () => {
  it('masks the canonical form and the ways a person types it', () => {
    expect(ReferenceNumber.maskWithin('BZR-2610-NZ58VK')).toBe('BZR-2610-••••••');
    expect(ReferenceNumber.maskWithin('see bzr-2610-nz58vk')).toBe('see BZR-2610-••••••');
    expect(ReferenceNumber.maskWithin('BZR 2610 NZ58VK, BZR2610NZ58VK')).toBe('BZR-2610-••••••, BZR-2610-••••••');
    expect(ReferenceNumber.maskWithin('ref_BZR-2610-NZ58VK')).toBe('ref_BZR-2610-••••••');
  });

  it('leaves a unit code, a phone and a longer token alone', () => {
    expect(ReferenceNumber.maskWithin('Z-1-45-A-201 +96170123456')).toBe('Z-1-45-A-201 +96170123456');
    expect(ReferenceNumber.maskWithin('XBZR-2610-NZ58VK1')).toBe('XBZR-2610-NZ58VK1');
  });
});
