import { foreignKeyViolated, isSerializationFailure, isUniqueViolation, isUniqueViolationOn } from './prisma-errors';

/*
  The shapes Prisma 5 sends, built as plain objects: the predicates match on
  `code` and `meta`, never on a class, because the registry and tenant clients
  each generate their own (an `instanceof` against one misses the other's).
*/
function prismaError(code: string, target?: unknown, meta?: Record<string, unknown>): Error {
  return Object.assign(new Error(`Prisma ${code}`), {
    name: 'PrismaClientKnownRequestError',
    code,
    ...(target === undefined && meta === undefined ? {} : { meta: { ...(target === undefined ? {} : { target }), ...meta } }),
  });
}

describe('isUniqueViolation', () => {
  it('is any P2002, whatever its target', () => {
    expect(isUniqueViolation(prismaError('P2002', ['email']))).toBe(true);
    expect(isUniqueViolation(prismaError('P2002'))).toBe(true);
  });

  it('is nothing else', () => {
    expect(isUniqueViolation(prismaError('P2003', ['buildingId_fkey']))).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
  });
});

describe('isUniqueViolationOn', () => {
  it('reads a field list, the shape of a model write', () => {
    const error = prismaError('P2002', ['clientRequestId']);
    expect(isUniqueViolationOn(error, 'clientRequestId')).toBe(true);
    expect(isUniqueViolationOn(error, 'email')).toBe(false);
  });

  it('reads a constraint name, the shape of some other writes', () => {
    const error = prismaError('P2002', 'expense_vouchers_salary_period_key');
    expect(isUniqueViolationOn(error, 'salary_period')).toBe(true);
    expect(isUniqueViolationOn(error, 'clientRequestId')).toBe(false);
  });

  it('says no when the target is missing or of another shape', () => {
    expect(isUniqueViolationOn(prismaError('P2002'), 'email')).toBe(false);
    expect(isUniqueViolationOn(prismaError('P2002', { fields: ['email'] }), 'email')).toBe(false);
  });

  it('never matches another code naming the same field', () => {
    expect(isUniqueViolationOn(prismaError('P2003', ['email']), 'email')).toBe(false);
  });
});

describe('foreignKeyViolated', () => {
  it('names the constraint a P2003 broke', () => {
    const error = prismaError('P2003', undefined, { field_name: 'property_entries_buildingId_fkey (index)' });
    expect(foreignKeyViolated(error)).toBe('property_entries_buildingId_fkey (index)');
  });

  it('answers an empty name, not null, for a P2003 that names nothing', () => {
    expect(foreignKeyViolated(prismaError('P2003'))).toBe('');
  });

  it('is null for anything else', () => {
    expect(foreignKeyViolated(prismaError('P2002', ['email']))).toBeNull();
    expect(foreignKeyViolated(new Error('P2003'))).toBeNull();
    expect(foreignKeyViolated(null)).toBeNull();
  });
});

describe('isSerializationFailure', () => {
  it('is P2034, a write conflict or a deadlock that rolled the transaction back', () => {
    expect(isSerializationFailure(prismaError('P2034'))).toBe(true);
  });

  it('is nothing else', () => {
    expect(isSerializationFailure(prismaError('P2002', ['email']))).toBe(false);
    expect(isSerializationFailure(new Error('deadlock detected'))).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});
