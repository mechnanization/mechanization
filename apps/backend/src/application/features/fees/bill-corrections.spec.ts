import type { AuditRow } from '../../../domain/interfaces/audit-repository.interface';
import { affectsBill, figureKey, linesDiff, traceChanges, type TracedChange } from './bill-corrections';

const CITIZEN = 'c-1';
const TENANT = 't-1';
const holder = { citizenId: CITIZEN, unitCodes: new Set(['Z-1-45-A-101']) };

let seq = 0;
const row = (over: Partial<AuditRow>): AuditRow => ({
  id: `row-${(seq += 1)}`,
  actorId: 'officer',
  actorType: 'STAFF',
  actorRole: 'FIELD_INSPECTOR',
  actorEmail: null,
  action: 'CITIZEN_UPDATED',
  entityType: 'User',
  entityId: CITIZEN,
  before: null,
  after: null,
  ipAddress: null,
  createdAt: new Date('2026-09-20T10:00:00Z'),
  ...over,
});
const kinds = (traced: TracedChange[]) => traced.map((change) => change.kind);

describe('traceChanges — edits to the file', () => {
  it('an edit saved with a reason is a correction', () => {
    expect(kinds(traceChanges([row({ after: { reason: 'خطأ في النسخ', changed: ['residence'] } })], holder))).toEqual(['CORRECTION']);
  });

  it('a move into or out of the town is a real change on the day it took effect', () => {
    const after = { changed: ['residence'], cards: [{ kind: 'changed' }], reason: 'انتقل للسكن في بيروت', movedOn: '2026-08-01T00:00:00.000Z' };
    const [change] = traceChanges([row({ after })], holder);
    expect(change).toMatchObject({ kind: 'DATED_CHANGE', effectiveOn: new Date('2026-08-01T00:00:00.000Z') });
  });

  it('an edit that touched no card is not a billing change', () => {
    expect(traceChanges([row({ after: { changed: ['phone', 'maritalStatus'] } })], holder)).toEqual([]);
  });

  it('an entry written before edits named their fields is read as an edit', () => {
    expect(kinds(traceChanges([row({ after: { propertyCount: 2, propertiesRemoved: 1 } })], holder))).toEqual(['EDIT']);
  });

  it('an old entry with a dated removal is still only an edit: it cannot say nothing else changed', () => {
    const after = {
      propertyCount: 1,
      propertiesRemoved: 1,
      removals: [{ propertyId: 'p', reason: 'MOVED_OUT', endedAt: '2026-09-10T00:00:00.000Z' }],
    };
    expect(kinds(traceChanges([row({ after })], holder))).toEqual(['EDIT']);
  });

  it('a card removed as «سُجّل خطأً» is a correction', () => {
    const after = {
      cards: [{ kind: 'removed' }],
      removals: [{ propertyId: 'p', reason: 'RECORDED_IN_ERROR' }],
    };
    expect(kinds(traceChanges([row({ after })], holder))).toEqual(['CORRECTION']);
  });

  it('cards removed only by dated real endings are a dated change, from the earliest day', () => {
    const after = {
      cards: [{ kind: 'removed' }, { kind: 'removed' }],
      removals: [
        { propertyId: 'p1', reason: 'OWNERSHIP_TRANSFERRED', endedAt: '2026-09-10T00:00:00.000Z' },
        { propertyId: 'p2', reason: 'OWNERSHIP_TRANSFERRED', endedAt: '2026-08-01T00:00:00.000Z' },
      ],
    };
    const [change] = traceChanges([row({ after })], holder);
    expect(change).toMatchObject({ kind: 'DATED_CHANGE', effectiveOn: new Date('2026-08-01T00:00:00.000Z') });
  });

  it('a removal with no day, or beside other card changes, is an edit', () => {
    const undated = { cards: [{ kind: 'removed' }], removals: [{ propertyId: 'p', reason: 'MOVED_OUT' }] };
    const mixed = {
      changed: ['phone'],
      cards: [{ kind: 'removed' }, { kind: 'added' }],
      removals: [{ propertyId: 'p', reason: 'MOVED_OUT', endedAt: '2026-09-10T00:00:00.000Z' }],
    };
    expect(kinds(traceChanges([row({ after: undated }), row({ after: mixed })], holder))).toEqual(['EDIT', 'EDIT']);
  });

  it('endings on the file: the reason decides, the day comes with it', () => {
    const traced = traceChanges(
      [
        row({ action: 'OWNERSHIP_ENDED', after: { reason: 'OWNERSHIP_TRANSFERRED', endedAt: '2026-09-01T00:00:00.000Z' } }),
        row({ action: 'TENANCY_ENDED', after: { reason: 'RECORDED_IN_ERROR', endedAt: '2026-09-21T00:00:00.000Z' } }),
      ],
      holder,
    );
    expect(traced.map((change) => [change.kind, change.effectiveOn?.toISOString() ?? null])).toEqual([
      ['DATED_CHANGE', '2026-09-01T00:00:00.000Z'],
      ['CORRECTION', null],
    ]);
  });

  it('another citizen’s file is not theirs', () => {
    expect(traceChanges([row({ entityId: 'someone-else', after: { reason: 'x', cards: [{ kind: 'changed' }] } })], holder)).toEqual([]);
  });
});

describe('traceChanges — rows on the building', () => {
  const building = (over: Partial<AuditRow>) => row({ entityType: 'Building', entityId: 'b-1', ...over });

  it('the building’s copy of an ending the file already records is left to the file', () => {
    const copy = building({
      action: 'OCCUPANCY_ENDED',
      before: { unitCode: 'Z-1-45-A-101', citizenId: CITIZEN },
      after: { reason: 'MOVED_OUT', toDate: '2026-09-01T00:00:00.000Z', via: 'TENANCY_ENDED' },
    });
    expect(traceChanges([copy], holder)).toEqual([]);
  });

  it('the owner’s side of a tenant moving out carries the tenant’s day', () => {
    const tenantEnded = building({
      action: 'OCCUPANCY_ENDED',
      before: { unitCode: 'Z-1-45-A-101', citizenId: TENANT },
      after: { reason: 'MOVED_OUT', toDate: '2026-09-05T00:00:00.000Z', via: 'TENANCY_ENDED' },
    });
    const status = building({
      action: 'UNIT_STATUS_AFTER_TENANCY',
      before: { unitCode: 'Z-1-45-A-101', unitStatus: 'RENTED' },
      after: { afterStatus: 'OWNER_OCCUPIED', tenantId: TENANT },
    });
    const link = row({ action: 'LANDLORD_TENANCY_ENDED', after: { tenantId: TENANT, reason: 'MOVED_OUT' } });
    const traced = traceChanges([tenantEnded, status, link], holder);
    expect(traced.map((change) => [change.row.action, change.kind, change.effectiveOn?.toISOString()])).toEqual([
      ['OCCUPANCY_ENDED', 'DATED_CHANGE', '2026-09-05T00:00:00.000Z'],
      ['UNIT_STATUS_AFTER_TENANCY', 'DATED_CHANGE', '2026-09-05T00:00:00.000Z'],
      ['LANDLORD_TENANCY_ENDED', 'DATED_CHANGE', '2026-09-05T00:00:00.000Z'],
    ]);
  });

  it('a unit edit counts only when it moved what billing reads, on a unit they hold', () => {
    const traced = traceChanges(
      [
        building({ action: 'UNIT_UPDATED', after: { unitCode: 'Z-1-45-A-101', changedFields: ['unitArea'] } }),
        building({ action: 'UNIT_UPDATED', after: { unitCode: 'Z-1-45-A-101', changedFields: ['floor'] } }),
        building({ action: 'UNIT_UPDATED', after: { unitCode: 'Z-1-45-A-202', changedFields: ['unitArea'] } }),
        building({ action: 'BUILDING_UPDATED', after: { unitCode: 'Z-1-45-A-101' } }),
      ],
      holder,
    );
    expect(traced.map((change) => change.row.after)).toEqual([{ unitCode: 'Z-1-45-A-101', changedFields: ['unitArea'] }]);
  });

  it('a vacancy lifted as «سُجّل خطأً» is a correction', () => {
    const lifted = building({ action: 'UNIT_VACANCY_ENDED', after: { unitCode: 'Z-1-45-A-101', reason: 'RECORDED_IN_ERROR' } });
    expect(kinds(traceChanges([lifted], holder))).toEqual(['CORRECTION']);
  });
});

describe('affectsBill', () => {
  const raisedAt = new Date('2026-09-15T09:30:00Z');
  const dated = (on: string): TracedChange => ({ row: row({}), kind: 'DATED_CHANGE', effectiveOn: new Date(on) });

  it('a real change after the bill leaves it right', () => {
    expect(affectsBill([dated('2026-09-16T00:00:00Z')], raisedAt)).toBe(false);
  });

  it('a real change on or before the day it was raised means the register was late', () => {
    expect(affectsBill([dated('2026-09-15T00:00:00Z')], raisedAt)).toBe(true);
    expect(affectsBill([dated('2026-08-01T00:00:00Z')], raisedAt)).toBe(true);
  });

  it('any correction or edit is enough; nothing recorded is not', () => {
    expect(affectsBill([dated('2026-09-20T00:00:00Z'), { row: row({}), kind: 'EDIT', effectiveOn: null }], raisedAt)).toBe(true);
    expect(affectsBill([], raisedAt)).toBe(false);
  });
});

describe('linesDiff and figureKey', () => {
  const line = (propertyNumber: string, unitType: string, unitArea: number | null = null) => ({
    propertyNumber,
    propertyType: 'BUILDING',
    unitType,
    unitArea,
  });

  it('matches lines one for one, so two identical shops and one left reads as one removed', () => {
    expect(linesDiff([line('45', 'SHOP'), line('45', 'SHOP'), line('46', 'OFFICE')], [line('45', 'SHOP'), line('47', 'SHOP')])).toEqual({
      removed: [line('45', 'SHOP'), line('46', 'OFFICE')],
      added: [line('47', 'SHOP')],
    });
  });

  it('keys a figure by what it is, and an amount only when there is one', () => {
    expect(figureKey({ kind: 'ASSESSED', amount: 2000, assessment: null })).toBe('ASSESSED:2000');
    expect(figureKey({ kind: 'UNASSESSABLE', reason: 'لم تُجرد' })).toBe('UNASSESSABLE');
    expect(figureKey({ kind: 'NOT_TARGETED' })).toBe('NOT_TARGETED');
  });
});
