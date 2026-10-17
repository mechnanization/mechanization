import type { ReportingService } from '../../application/features/reporting/reporting.service';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { CitizenController } from './citizen.controller';

/*
  «ملفّي» — what the citizen portal sends a citizen about the flats they hold.

  The staff profile lists each flat's current owners with their numbers, and
  for an owner with none of their own, «لا يملك رقم هاتف» and a relative's
  number. A tenant sees who owns the flat and the أسهم; nobody's number — the
  landlord's is on the card. The portal used to drop named fields and pass the
  rest through, so the relative's number added to the staff view (2026-10-06)
  would have reached it; it now names what it sends.
*/

const OWNER = {
  citizenId: '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f',
  name: 'سامي خوري',
  phone: null,
  hasNoPhone: true,
  contactPhone: '+96171123456',
  shares: 1200,
};

function controller(profile: unknown) {
  const reporting = { getCitizenProfile: jest.fn().mockResolvedValue(profile) } as unknown as ReportingService;
  const none = {} as never;
  return new CitizenController(none, reporting, none, none, none, none, none);
}

describe('the citizen portal summary', () => {
  it("sends a flat's owners as names and أسهم, never a number of theirs or a relative's", async () => {
    const summary = await controller({
      fullName: 'ليلى حداد',
      registrations: [
        {
          flags: [],
          properties: [
            {
              endedAt: null,
              landlordCitizenId: OWNER.citizenId,
              landlordReferenceNumber: 'BZR-2610-NZ58VK',
              units: [{ id: 'line-1', owners: [OWNER] }],
            },
          ],
        },
      ],
      payments: [],
      fees: [],
    }).mySummary({ sub: 'citizen-1' } as SessionClaims);

    const [property] = summary.properties as Array<Record<string, unknown> & { units: Array<{ owners: unknown[] }> }>;
    expect(property).not.toHaveProperty('landlordCitizenId');
    expect(property).not.toHaveProperty('landlordReferenceNumber');
    expect(property!.units[0]!.owners).toEqual([{ name: OWNER.name, shares: OWNER.shares }]);
  });

  it('says how a co-owned flat is divided and this person’s own part — never who else pays', async () => {
    const billing = (responsibleOwnerId: string) => ({
      mode: 'RESPONSIBLE_OWNER',
      effectiveMode: 'RESPONSIBLE_OWNER',
      responsibleOwnerId,
      fallback: null,
      share: { numerator: responsibleOwnerId === 'citizen-1' ? 1 : 0, denominator: 1 },
    });
    const summaryFor = (responsibleOwnerId: string) =>
      controller({
        fullName: 'علي سرور',
        registrations: [
          {
            flags: [],
            properties: [{ endedAt: null, units: [{ id: 'line-1', owners: [OWNER], ownerBilling: billing(responsibleOwnerId) }] }],
          },
        ],
        payments: [],
        fees: [],
      }).mySummary({ sub: 'citizen-1' } as SessionClaims);

    const mine = await summaryFor('citizen-1');
    const [property] = mine.properties as Array<{ units: Array<{ ownerBilling: Record<string, unknown> }> }>;
    // Their part says they pay for all — the same fact the staff file reads it from.
    expect(property!.units[0]!.ownerBilling).toEqual({
      mode: 'RESPONSIBLE_OWNER',
      effectiveMode: 'RESPONSIBLE_OWNER',
      share: { numerator: 1, denominator: 1 },
    });

    const brothers = await summaryFor(OWNER.citizenId);
    const [other] = brothers.properties as Array<{ units: Array<{ ownerBilling: Record<string, unknown> }> }>;
    expect(other!.units[0]!.ownerBilling).toEqual({
      mode: 'RESPONSIBLE_OWNER',
      effectiveMode: 'RESPONSIBLE_OWNER',
      share: { numerator: 0, denominator: 1 },
    });
    expect(other!.units[0]!.ownerBilling).not.toHaveProperty('responsibleOwnerId');
    expect(other!.units[0]!.ownerBilling).not.toHaveProperty('fallback');
  });

  it("says the same of a house's flat, which has no unit line — and survives a profile cached before it", async () => {
    const summary = await controller({
      fullName: 'علي سرور',
      registrations: [
        {
          flags: [],
          properties: [
            {
              endedAt: null,
              units: [],
              heldUnits: [
                {
                  unitId: 'unit-1',
                  unitCode: '0001',
                  feeExemption: 'PLACE_OF_WORSHIP',
                  ownerBilling: {
                    mode: 'RESPONSIBLE_OWNER',
                    effectiveMode: 'RESPONSIBLE_OWNER',
                    responsibleOwnerId: OWNER.citizenId,
                    fallback: null,
                    share: { numerator: 0, denominator: 1 },
                  },
                },
              ],
            },
            { endedAt: null, units: [] },
          ],
        },
      ],
      payments: [],
      fees: [],
    }).mySummary({ sub: 'citizen-1' } as SessionClaims);

    const [house, cached] = summary.properties as Array<{ heldUnits: Array<Record<string, unknown>> }>;
    expect(house!.heldUnits).toEqual([
      {
        unitId: 'unit-1',
        unitCode: '0001',
        feeExemption: 'PLACE_OF_WORSHIP',
        ownerBilling: {
          mode: 'RESPONSIBLE_OWNER',
          effectiveMode: 'RESPONSIBLE_OWNER',
          share: { numerator: 0, denominator: 1 },
        },
      },
    ]);
    expect(cached!.heldUnits).toEqual([]);
  });
});
