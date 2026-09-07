import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateCaseInput, UpdateCaseInput } from '@mechanization/shared-schemas';
import { CASE_REPOSITORY, USER_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import type {
  Case,
  CaseListFilter,
  CaseRepository,
} from '../../../domain/interfaces/case-repository.interface';
import type { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { NotFoundError, ValidationError } from '../../common/exceptions';

@Injectable()
export class CasesService {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly events: EventEmitter2,
  ) {}

  private recordChange(input: {
    action: 'CASE_CREATED' | 'CASE_UPDATED' | 'CASE_RESOLVED_WITH_CITIZEN' | 'CASE_DELETED';
    caseId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actor: { id: string; role: string };
  }): void {
    this.events.emit('case.changed', {
      caseId: input.caseId,
      action: input.action,
      before: input.before,
      after: input.after,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  async list(filter?: CaseListFilter): Promise<Case[]> {
    return this.cases.findAll(filter);
  }

  async get(id: string): Promise<Case> {
    const found = await this.cases.findById(id);
    if (!found) throw new NotFoundError('الحالة غير موجودة');
    return found;
  }

  async create(input: CreateCaseInput, actor: { id: string; role: string }): Promise<Case> {
    const created = await this.cases.create({ ...input, createdById: actor.id });

    this.recordChange({
      action: 'CASE_CREATED',
      caseId: created.id,
      after: { propertyNumber: created.propertyNumber, notes: created.notes },
      actor,
    });

    return created;
  }

  /**
   * `resolvedCitizenId` is the bridge this exists for, and it gets one rule
   * beyond a plain field write: setting it always resolves the case, because
   * a case with a linked citizen and an OPEN status would be a contradiction
   * — the thing it was waiting on has happened. Clearing it does *not* run
   * the rule in reverse: a case someone unlinks (wrong citizen picked) may
   * still be genuinely resolved some other way, so status is left alone.
   */
  async update(
    id: string,
    input: UpdateCaseInput,
    actor: { id: string; role: string },
  ): Promise<Case> {
    const existing = await this.cases.findById(id);
    if (!existing) throw new NotFoundError('الحالة غير موجودة');

    let patch: UpdateCaseInput = input;

    if (input.resolvedCitizenId !== undefined) {
      if (input.resolvedCitizenId) {
        const citizen = await this.users.findById(input.resolvedCitizenId);
        if (!citizen || citizen.kind !== 'CITIZEN') {
          throw new ValidationError('المواطن غير موجود', {
            resolvedCitizenId: input.resolvedCitizenId,
          });
        }
        patch = { ...input, status: 'RESOLVED' };
      }
    }

    const updated = await this.cases.update(id, {
      ...patch,
      ...(input.resolvedCitizenId !== undefined
        ? { resolvedAt: input.resolvedCitizenId ? new Date() : null }
        : {}),
    });

    this.recordChange({
      action:
        input.resolvedCitizenId !== undefined && input.resolvedCitizenId
          ? 'CASE_RESOLVED_WITH_CITIZEN'
          : 'CASE_UPDATED',
      caseId: id,
      before: { status: existing.status, resolvedCitizenId: existing.resolvedCitizenId },
      after: { status: updated.status, resolvedCitizenId: updated.resolvedCitizenId },
      actor,
    });

    return updated;
  }

  async remove(id: string, actor: { id: string; role: string }): Promise<void> {
    const existing = await this.cases.findById(id);
    if (!existing) throw new NotFoundError('الحالة غير موجودة');

    await this.cases.delete(id);

    this.recordChange({
      action: 'CASE_DELETED',
      caseId: id,
      before: { propertyNumber: existing.propertyNumber, notes: existing.notes },
      actor,
    });
  }
}
