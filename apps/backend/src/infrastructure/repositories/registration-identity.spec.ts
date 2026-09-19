import { isSamePerson, PrismaRegistrationRepository } from './registration.repository';

/**
 * The identity-document merge, pinned.
 *
 * On the first day of field work in production (2026-09-12) the registration
 * path upserted citizens on (نوع الوثيقة, رقم الوثيقة), and its update branch
 * wrote the new filing's name over whoever already held the number. Officers
 * had been told the document was not required and typed shared or invented
 * numbers, so brothers filed one after another became one citizen carrying the
 * last brother's name — and nothing kept the others.
 *
 * These tests assert the three outcomes that replaced the upsert, and above all
 * the one that failed: **a different person is never written over**. Mocked
 * rather than run against Postgres because the property under test is which
 * writes are issued at all — an integration fixture shows the rows it holds,
 * not the `update` that should never have been called.
 */

function harness(
  holder: { firstName: string; middleName: string | null; lastName: string } | null,
  /** The flags on the holder's newest registration. */
  holderFlags: Array<{ path: string; kind: string; reason: string }> = [],
) {
  const tx = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        holder ? { id: 'holder-1', kind: 'CITIZEN', ...holder } : null,
      ),
      create: jest.fn().mockResolvedValue({ id: 'new-citizen' }),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    registration: {
      create: jest.fn().mockResolvedValue({ id: 'reg-1', referenceNumber: 'BZR-1' }),
      findFirst: jest.fn().mockResolvedValue(holder ? { flaggedFields: holderFlags } : null),
    },
    propertyEntry: { create: jest.fn() },
  };
  const db = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) };
  const repository = new PrismaRegistrationRepository({
    prisma: db,
    tenantSlug: 'albazourieh',
  } as never);
  return { repository, tx };
}

function filing(citizen: Record<string, unknown>) {
  return {
    citizen: { firstName: 'يوسف', lastName: 'جفال', ...citizen } as never,
    citizenReference: 'BZR-C-1',
    registrationReference: 'BZR-R-1',
    properties: [],
    status: 'PENDING' as const,
    flaggedFields: [],
  };
}

describe('registration — a document number never merges two people', () => {
  it('writes a new citizen carrying the number when nobody holds it', async () => {
    const { repository, tx } = harness(null);

    const result = await repository.submit(
      filing({ identityDocType: 'PASSPORT', identityDocNumber: 'N123456' }),
    );

    expect(result.identity).toBe('NEW');
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ identityDocType: 'PASSPORT', identityDocNumber: 'N123456' }),
      }),
    );
  });

  it('adds the filing to the holder when the name is the same — and rewrites nothing on them', async () => {
    const { repository, tx } = harness({ firstName: 'يوسف', middleName: 'علي', lastName: 'جفال' });

    const result = await repository.submit(
      filing({ identityDocType: 'PASSPORT', identityDocNumber: 'N123456', phone: '+96170000000' }),
    );

    expect(result.identity).toBe('ATTACHED');
    expect(result.citizenId).toBe('holder-1');
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.upsert).not.toHaveBeenCalled();
    expect(tx.registration.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ citizenId: 'holder-1' }) }),
    );
  });

  /**
   * The edit form clears «سجل مشابه» from a citizen's newest registration only.
   * Left behind on the holder's older one, the flag — and the quality finding
   * read from it — could never be answered.
   */
  it('carries the holder’s open «سجل مشابه» onto the filing that becomes their newest', async () => {
    const standing = { path: 'personal.possibleDuplicate', kind: 'UNVERIFIED', reason: 'قد يكون: يوسف جفال' };
    const { repository, tx } = harness({ firstName: 'يوسف', middleName: 'علي', lastName: 'جفال' }, [standing]);

    await repository.submit(filing({ identityDocType: 'PASSPORT', identityDocNumber: 'N123456' }));

    const registration = tx.registration.create.mock.calls[0][0].data;
    expect(registration.flaggedFields).toEqual([standing]);
    expect(registration.status).toBe('REQUIRES_REVIEW');
  });

  it('carries nothing when the holder’s newest registration has no «سجل مشابه»', async () => {
    const { repository, tx } = harness({ firstName: 'يوسف', middleName: 'علي', lastName: 'جفال' });

    await repository.submit(filing({ identityDocType: 'PASSPORT', identityDocNumber: 'N123456' }));

    expect(tx.registration.create.mock.calls[0][0].data.flaggedFields).toEqual([]);
  });

  it('keeps a different person separate, without the number, and says why', async () => {
    // The production shape: brother two filed under brother one's number.
    const { repository, tx } = harness({ firstName: 'حسن', middleName: 'علي', lastName: 'جفال' });

    const result = await repository.submit(
      filing({ identityDocType: 'PASSPORT', identityDocNumber: 'N123456' }),
    );

    expect(result.identity).toBe('CONFLICT');
    expect(result.citizenId).toBe('new-citizen');
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.upsert).not.toHaveBeenCalled();

    const created = tx.user.create.mock.calls[0][0].data;
    expect(created.firstName).toBe('يوسف');
    expect(created.identityDocNumber).toBeNull();
    expect(created.identityDocType).toBeNull();

    const registration = tx.registration.create.mock.calls[0][0].data;
    expect(registration.status).toBe('REQUIRES_REVIEW');
    expect(registration.flaggedFields).toEqual([
      expect.objectContaining({
        path: 'personal.identityDocNumber',
        kind: 'UNESTABLISHED',
        reason: expect.stringContaining('N123456'),
      }),
    ]);
  });

  it('creates without looking anything up when no number is given', async () => {
    const { repository, tx } = harness(null);

    const result = await repository.submit(filing({}));

    expect(result.identity).toBeUndefined();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('isSamePerson', () => {
  it('folds the spellings a doorstep produces', () => {
    expect(
      isSamePerson(
        { firstName: 'أحمد', middleName: null, lastName: 'سرور' },
        { firstName: 'احمد', lastName: 'سرور' },
      ),
    ).toBe(true);
  });

  it('compares اسم الأب only when both sides have one', () => {
    const holder = { firstName: 'علي', middleName: 'حسن', lastName: 'جفال' };
    expect(isSamePerson(holder, { firstName: 'علي', lastName: 'جفال' })).toBe(true);
    expect(isSamePerson(holder, { firstName: 'علي', middleName: 'محمد', lastName: 'جفال' })).toBe(false);
  });

  it('treats a different first name as a different person', () => {
    expect(
      isSamePerson(
        { firstName: 'يوسف', middleName: 'علي', lastName: 'جفال' },
        { firstName: 'حسن', middleName: 'علي', lastName: 'جفال' },
      ),
    ).toBe(false);
  });
});
