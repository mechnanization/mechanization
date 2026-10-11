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

  it.each(['system', 'not-a-uuid', ['SYSTEM', 'SYSTEM']])('refuses %p before it reaches the query', (value) => {
    expect(() => pipe.transform(value)).toThrow(ValidationError);
  });
});
