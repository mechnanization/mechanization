import { WORKLIST_UNASSIGNED, worklistQuerySchema } from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ValidationError } from '../../common/exceptions';

/*
  The query of the three collection worklists — «يتطلب مراجعة», «وحدات غير
  ممسوحة», «بانتظار إعادة الكشف» — goes through the same pipe the controllers
  use (`buildings.controller.ts`, `citizen.controller.ts`).

  Before it was validated, Express handed a repeated `?search=` over as an
  array and an unchecked `.trim()` on it answered 500. A refusal here is a
  `ValidationError`, which the one filter turns into a 400.
*/

const pipe = new ZodValidationPipe(worklistQuerySchema);
const STAFF_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const refusal = (query: Record<string, unknown>): ValidationError => {
  try {
    pipe.transform(query);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error(`accepted ${JSON.stringify(query)}`);
};
const refusedPaths = (query: Record<string, unknown>) =>
  (refusal(query).details as Array<{ path: string }>).map((issue) => issue.path);

describe('the worklist query', () => {
  it('fills the page when nothing is sent', () => {
    expect(pipe.transform({})).toEqual({ limit: 25, offset: 0 });
  });

  it('reads the page from the strings a query string carries', () => {
    expect(pipe.transform({ limit: '50', offset: '100' })).toEqual({ limit: 50, offset: 100 });
  });

  it('refuses a repeated search with a 400, not a 500', () => {
    expect(refusedPaths({ search: ['أبو', 'علي'] })).toEqual(['search']);
  });

  it('trims the search, and caps it at 120 characters because it feeds several ILIKEs', () => {
    expect(pipe.transform({ search: '  خوري  ' }).search).toBe('خوري');
    expect(pipe.transform({ search: 'س'.repeat(120) }).search).toHaveLength(120);
    expect(refusedPaths({ search: 'س'.repeat(121) })).toEqual(['search']);
  });

  it('keeps the page inside its bounds', () => {
    expect(refusedPaths({ limit: '0' })).toEqual(['limit']);
    expect(refusedPaths({ limit: '101' })).toEqual(['limit']);
    expect(refusedPaths({ limit: '2.5' })).toEqual(['limit']);
    expect(refusedPaths({ offset: '-1' })).toEqual(['offset']);
    expect(refusedPaths({ offset: 'abc' })).toEqual(['offset']);
    expect(pipe.transform({ limit: '100' }).limit).toBe(100);
  });

  it('takes a staff id or «بلا مسؤول» as the owner, and nothing else', () => {
    expect(pipe.transform({ owner: STAFF_ID }).owner).toBe(STAFF_ID);
    expect(pipe.transform({ owner: WORKLIST_UNASSIGNED }).owner).toBe(WORKLIST_UNASSIGNED);
    expect(refusedPaths({ owner: 'unassigned' })).toEqual(['owner']);
    expect(refusedPaths({ owner: 'not-a-uuid' })).toEqual(['owner']);
    expect(refusedPaths({ owner: [STAFF_ID, STAFF_ID] })).toEqual(['owner']);
  });
});
