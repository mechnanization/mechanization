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
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';

/**
 * The follow-up case types a unit can only usefully have one of at a time.
 *
 * A second open «تعذّر الوصول» on a shop that already has one is the same door
 * twice on the dispatch list — production held exactly that pair on
 * 2026-09-15, same officer, same day. `GENERAL_NOTE` and `OWNERSHIP_DISPUTE`
 * are left alone: several notes on one unit are ordinary.
 */
const ONE_OPEN_PER_UNIT: ReadonlySet<string> = new Set([
  'UNIT_UNREACHABLE',
  'ACCESS_REFUSED',
  'VACANT_UNCONFIRMED',
]);

@Injectable()
export class CasesService {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly events: EventEmitter2,
  ) {}

  private recordChange(input: {
    action:
      | 'CASE_CREATED'
      | 'CASE_UPDATED'
      | 'CASE_RESOLVED_WITH_CITIZEN'
      /** Closed by a finding rather than by a person — see `resolveVacancyCasesForUnit`. */
      | 'CASE_RESOLVED'
      | 'CASE_DELETED';
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

  /** The open case of a `ONE_OPEN_PER_UNIT` type already on this unit, if any. */
  private async standingCase(input: CreateCaseInput): Promise<Case | null> {
    if (!input.unitId || !input.caseType || !ONE_OPEN_PER_UNIT.has(input.caseType)) return null;
    const rows = await this.cases.findAll({ unitId: input.unitId, caseType: input.caseType });
    return rows.find((row) => row.status === 'OPEN' || row.status === 'SCHEDULED') ?? null;
  }

  /** An officer opening a case. Refuses a second open one of a one-per-door type. */
  async create(input: CreateCaseInput, actor: { id: string; role: string }): Promise<Case> {
    const standing = await this.standingCase(input);
    if (standing) {
      throw new ConflictError('توجد حالة متابعة مفتوحة من النوع نفسه على هذه الوحدة — لم تُفتح حالة ثانية', {
        existingCaseId: standing.id,
      });
    }
    return this.insert(input, actor);
  }

  /**
   * The system opening a case as a side effect of something else — a tenancy
   * ended with «لا أعرف» asks somebody to go and look.
   *
   * Where that question is already open on the unit, it is already asked, so
   * the standing case is returned instead of a second one. Refusing here, as
   * `create` does for an officer, would fail the write this is a side effect
   * of: it runs inside that transaction.
   */
  async openUnlessStanding(
    input: CreateCaseInput,
    actor: { id: string; role: string },
  ): Promise<{ case: Case; opened: boolean }> {
    const standing = await this.standingCase(input);
    if (standing) return { case: standing, opened: false };
    return { case: await this.insert(input, actor), opened: true };
  }

  private async insert(input: CreateCaseInput, actor: { id: string; role: string }): Promise<Case> {
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

  /**
   * Closes the cases a newly-recorded occupancy has just answered.
   *
   * Called from `BuildingsService.recordOccupancy`, because that is the moment
   * the thing these cases were waiting on actually happened: a حالة on a flat
   * says «لم يتم الرد», and an occupancy on that flat says who lives there.
   * Leaving it open sends a second officer to a door the municipality has
   * already been through — which is the specific waste the cases table exists
   * to prevent, arrived at from the other side.
   *
   * Only cases pinned to that exact `unitId`. A case carrying nothing but a
   * free-text «الطابق الثاني» is not resolved by this, and must not be: nothing
   * here can tell which of the second floor's four flats the officer meant, and
   * closing the wrong one loses a visit that still needs making.
   *
   * Returns the count so the caller can tell the officer what just closed —
   * silently resolving someone else's case is how a dispatch list stops being
   * believed.
   */
  async resolveForUnit(
    unitId: string,
    citizenId: string,
    actor: { id: string; role: string },
  ): Promise<number> {
    const open = await this.cases.findAll({ unitId, status: 'OPEN' });
    const scheduled = await this.cases.findAll({ unitId, status: 'SCHEDULED' });
    const affected = [...open, ...scheduled];
    if (affected.length === 0) return 0;

    const resolved = await this.cases.resolveOpenForUnit(unitId, citizenId);

    for (const existing of affected) {
      this.recordChange({
        action: 'CASE_RESOLVED_WITH_CITIZEN',
        caseId: existing.id,
        before: { status: existing.status, resolvedCitizenId: existing.resolvedCitizenId },
        after: { status: 'RESOLVED', resolvedCitizenId: citizenId, via: 'UNIT_OCCUPANCY' },
        actor,
      });
    }

    return resolved;
  }

  /**
   * Closes the «شاغرة قيد التحقق» cases a confirmed vacancy has answered.
   *
   * Called from `BuildingsService.confirmVacancy`, for `resolveForUnit`'s
   * reason and with `resolveForUnit`'s restraint: this is the moment the thing
   * that case was waiting on actually happened, and nothing else on the unit is
   * answered by it. A refused entry is still refused, a disputed ownership
   * still disputed, and both stay on somebody's list.
   *
   * Audited per case like the occupancy path, so a case that closes without
   * anybody pressing anything on it still names what closed it.
   */
  async resolveVacancyCasesForUnit(
    unitId: string,
    actor: { id: string; role: string },
  ): Promise<number> {
    const open = await this.cases.findAll({ unitId, status: 'OPEN' });
    const scheduled = await this.cases.findAll({ unitId, status: 'SCHEDULED' });
    const affected = [...open, ...scheduled].filter(
      (existing) => existing.caseType === 'VACANT_UNCONFIRMED',
    );
    if (affected.length === 0) return 0;

    const resolved = await this.cases.resolveVacancyCasesForUnit(unitId);

    for (const existing of affected) {
      this.recordChange({
        action: 'CASE_RESOLVED',
        caseId: existing.id,
        before: { status: existing.status },
        after: { status: 'RESOLVED', via: 'VACANCY_CONFIRMED' },
        actor,
      });
    }

    return resolved;
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
