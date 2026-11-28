import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AUDIT_SYSTEM_ACTOR, auditActorFilterSchema } from '@mechanization/shared-schemas';
import { ValidationError } from '../../application/common/exceptions';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { AuditService } from '../../application/features/audit/audit.service';
import { AuditController } from './audit.controller';

/**
 * `?actorId=` on the audit reads: a person's id, or «النظام».
 *
 * The entries no person made have no actor id, so the daily report's «النظام»
 * row has nothing to filter by. Its drill-down sent no filter at all and listed
 * every actor's entries for the day. `SYSTEM` is the explicit answer; the
 * repository reads it as `"actorId" IS NULL` (audit-daily.integration.spec.ts).
 */
describe('AuditController — the actor filter', () => {
  const service = {
    query: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    daily: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const controller = new AuditController(service as unknown as AuditService);
  const pipe = new ZodValidationPipe(auditActorFilterSchema);
  const person = '6f1c2b8e-4d3a-4f5e-9a7b-1c2d3e4f5a6b';

  beforeEach(() => jest.clearAllMocks());

  it('reads SYSTEM as the entries with no actor, never as an actor id', async () => {
    await controller.query(pipe.transform(AUDIT_SYSTEM_ACTOR));
    await controller.daily(pipe.transform(AUDIT_SYSTEM_ACTOR));

    for (const call of [service.query.mock.calls[0]![0], service.daily.mock.calls[0]![0]]) {
      expect(call).toMatchObject({ systemActor: true });
      expect(call).not.toHaveProperty('actorId');
    }
  });

  it('passes a person’s id on as it is', async () => {
    await controller.query(pipe.transform(person));

    expect(service.query.mock.calls[0]![0]).toMatchObject({ actorId: person });
    expect(service.query.mock.calls[0]![0]).not.toHaveProperty('systemActor');
  });

  it('leaves the filter off when none was sent', async () => {
    await controller.query(pipe.transform(undefined));

    expect(service.query.mock.calls[0]![0]).not.toHaveProperty('actorId');
    expect(service.query.mock.calls[0]![0]).not.toHaveProperty('systemActor');
  });

  it.each(['system', 'not-a-uuid', ['SYSTEM', 'SYSTEM']])('the schema refuses %p', (value) => {
    expect(() => pipe.transform(value)).toThrow(ValidationError);
  });

  /*
    The cases above build the pipe themselves, so they hold with the pipe taken
    off a route. This reads the pipe each route declares on its own `actorId`
    (Nest's route-argument metadata) and runs it.
  */
  it.each([
    ['query', 'GET audit'],
    ['daily', 'GET audit/daily'],
  ] as const)('the %s handler (%s) runs the actor filter on its ?actorId=', (handler, _route) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AuditController, handler) as
      | Record<string, { data?: unknown; pipes?: unknown[] }>
      | undefined;
    const actorArg = Object.values(args ?? {}).find((arg) => arg.data === 'actorId');
    const routePipe = actorArg?.pipes?.find((candidate) => candidate instanceof ZodValidationPipe) as
      | ZodValidationPipe<typeof auditActorFilterSchema>
      | undefined;

    expect(routePipe).toBeDefined();
    expect(routePipe!.transform(AUDIT_SYSTEM_ACTOR)).toBe(AUDIT_SYSTEM_ACTOR);
    expect(routePipe!.transform(person)).toBe(person);
    expect(() => routePipe!.transform('system')).toThrow(ValidationError);
  });
});

/**
 * `?entityType=` and `?entityId=` on the audit reads (audit SEC-06): free text
 * up to the URL's length went on into the cache key. The type is checked by
 * shape and the id is a UUID, folded to lower case, or a short key, because the
 * log files a treasury day under its date and the old-debts settings under
 * `singleton`.
 */
describe('AuditController — the record filters', () => {
  const service = {
    query: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    daily: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const controller = new AuditController(service as unknown as AuditService);
  const query = (entityType?: string, entityId?: string) => controller.query(undefined, entityType, entityId);

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['User', '6F1C2B8E-4D3A-4F5E-9A7B-1C2D3E4F5A6B', '6f1c2b8e-4d3a-4f5e-9a7b-1c2d3e4f5a6b'],
    ['TreasuryDay', '2026-10-08', '2026-10-08'],
    ['ArrearsBatch', 'singleton', 'singleton'],
  ])('passes %s %s on, a UUID in lower case', async (entityType, entityId, expected) => {
    await query(entityType, entityId);
    expect(service.query.mock.calls[0]![0]).toMatchObject({ entityType, entityId: expected });
  });

  it('leaves both off when neither was sent', async () => {
    await query(undefined, undefined);
    await query('', '');
    for (const [call] of service.query.mock.calls) {
      expect(call).toMatchObject({ entityType: undefined, entityId: undefined });
    }
  });

  it.each([
    ['a type that is not a name', 'user', undefined],
    ['a type with markup', '<script>', undefined],
    ['a type the length of a page', `U${'s'.repeat(200)}`, undefined],
    ['an id with spaces', 'User', 'a b'],
    ['an id with a quote', 'User', "x'--"],
    ['an id the length of a page', 'User', 'a'.repeat(65)],
  ])('refuses %s with INVALID_QUERY_VALUE, before the service', async (_case, entityType, entityId) => {
    await expect(query(entityType, entityId)).rejects.toMatchObject({ code: 'INVALID_QUERY_VALUE' });
    expect(service.query).not.toHaveBeenCalled();
  });

  it('checks the type on the daily report too', async () => {
    await expect(controller.daily(undefined, 'user')).rejects.toMatchObject({ code: 'INVALID_QUERY_VALUE' });
    await controller.daily(undefined, 'Building');
    expect(service.daily.mock.calls[0]![0]).toMatchObject({ entityType: 'Building' });
  });
});
