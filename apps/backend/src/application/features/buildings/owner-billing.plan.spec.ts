import { setOwnerBillingSchema } from '@mechanization/shared-schemas';
import { planOwnerBilling, type OwnerBillingFacts } from './owner-billing.plan';

/**
 * Saving «توزيع الرسم على المالكين» — what is refused, and what is written.
 * Every refusal here is a choice billing could not carry out, refused where
 * the officer can still fix it rather than on the first bill.
 */

const facts = (overrides: Partial<OwnerBillingFacts> = {}): OwnerBillingFacts => ({
  unitCode: '0005',
  structural: false,
  mode: null,
  responsibleOwnerId: null,
  spells: [
    { id: 'spell-ali', citizenId: 'ali', shares: null },
    { id: 'spell-maarouf', citizenId: 'maarouf', shares: null },
    { id: 'spell-aref', citizenId: 'aref', shares: 1 },
    { id: 'spell-hussein', citizenId: 'hussein', shares: null },
  ],
  ...overrides,
});

describe('planOwnerBilling', () => {
  it('names one brother to pay for the shop (A2-420-A/0005)', () => {
    const planned = planOwnerBilling(facts(), { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.write).toMatchObject({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali', changed: true });
    expect(planned.write.shareWrites).toEqual([]);
  });

  it('refuses a responsible owner who does not own the flat', () => {
    const planned = planOwnerBilling(facts(), { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'a-tenant' });
    expect(planned).toEqual({
      ok: false,
      refusal: { code: 'OWNER_BILLING_RESPONSIBLE_NOT_OWNER', params: { unitCode: '0005' } },
    });
  });

  it('refuses a method on a flat with one owner, but lets a choice be withdrawn', () => {
    const alone = facts({ spells: [{ id: 'spell-ali', citizenId: 'ali', shares: null }], mode: 'EQUAL' });
    expect(planOwnerBilling(alone, { mode: 'EQUAL' })).toEqual({
      ok: false,
      refusal: { code: 'OWNER_BILLING_NOT_CO_OWNED', params: { unitCode: '0005', owners: 1 } },
    });
    const withdrawn = planOwnerBilling(alone, { mode: null });
    expect(withdrawn.ok && withdrawn.write).toMatchObject({ mode: null, responsibleOwnerId: null, changed: true });
  });

  it('refuses «حسب الأسهم» until every owner’s أسهم are on record', () => {
    expect(planOwnerBilling(facts(), { mode: 'BY_SHARES' })).toEqual({
      ok: false,
      refusal: { code: 'OWNER_BILLING_SHARES_MISSING', params: { unitCode: '0005', missing: 3 } },
    });
  });

  it('records the أسهم and the method in one save', () => {
    const planned = planOwnerBilling(facts(), {
      mode: 'BY_SHARES',
      shares: [
        { citizenId: 'ali', shares: 600 },
        { citizenId: 'maarouf', shares: 600 },
        { citizenId: 'aref', shares: 600 },
        { citizenId: 'hussein', shares: 600 },
      ],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.write.shareWrites.map((write) => write.spellId)).toEqual([
      'spell-ali',
      'spell-maarouf',
      'spell-aref',
      'spell-hussein',
    ]);
    expect(planned.write.rule.owners.every((owner) => owner.shares === 600)).toBe(true);
  });

  it('refuses أسهم for someone who is not an owner of the flat', () => {
    expect(planOwnerBilling(facts(), { mode: 'EQUAL', shares: [{ citizenId: 'stranger', shares: 100 }] })).toEqual({
      ok: false,
      refusal: { code: 'OWNER_BILLING_SHARES_NOT_OWNER', params: { unitCode: '0005' } },
    });
  });

  it('refuses a structural floor outright', () => {
    expect(planOwnerBilling(facts({ structural: true }), { mode: 'EQUAL' }).ok).toBe(false);
  });

  it('writes nothing when the same choice is saved again', () => {
    const chosen = facts({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    const planned = planOwnerBilling(chosen, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    expect(planned.ok && planned.write.changed).toBe(false);
  });

  it('drops the responsible owner when the method changes', () => {
    const chosen = facts({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    const planned = planOwnerBilling(chosen, { mode: 'EQUAL' });
    expect(planned.ok && planned.write).toMatchObject({ mode: 'EQUAL', responsibleOwnerId: null, changed: true });
  });
});

describe('setOwnerBillingSchema', () => {
  it('needs the responsible owner under «مالك مسؤول», and refuses one under any other method', () => {
    expect(setOwnerBillingSchema.safeParse({ mode: 'RESPONSIBLE_OWNER' }).success).toBe(false);
    expect(
      setOwnerBillingSchema.safeParse({ mode: 'EQUAL', responsibleOwnerId: '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f' })
        .success,
    ).toBe(false);
    expect(
      setOwnerBillingSchema.safeParse({
        mode: 'RESPONSIBLE_OWNER',
        responsibleOwnerId: '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f',
      }).success,
    ).toBe(true);
    expect(setOwnerBillingSchema.safeParse({ mode: null }).success).toBe(true);
  });

  it('refuses the same owner twice in the أسهم list, and أسهم out of range', () => {
    const id = '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f';
    expect(
      setOwnerBillingSchema.safeParse({
        mode: 'BY_SHARES',
        shares: [
          { citizenId: id, shares: 100 },
          { citizenId: id, shares: 200 },
        ],
      }).success,
    ).toBe(false);
    expect(setOwnerBillingSchema.safeParse({ mode: 'BY_SHARES', shares: [{ citizenId: id, shares: 2401 }] }).success).toBe(
      false,
    );
  });
});
