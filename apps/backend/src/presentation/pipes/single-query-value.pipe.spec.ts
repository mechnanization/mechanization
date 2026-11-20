import { SingleQueryValuePipe } from './single-query-value.pipe';

/**
 * A named query value is one string, or absent (task S11 of the 2026-11-14
 * security audit): `?search=a&search=b` arrived as an array, and a handler
 * typed `string` called `.toLowerCase()` on it — a 500.
 */
describe('SingleQueryValuePipe', () => {
  const pipe = new SingleQueryValuePipe();
  const query = (data?: string) => ({ type: 'query' as const, data });

  it('passes one string, or nothing', () => {
    expect(pipe.transform('أحمد', query('search'))).toBe('أحمد');
    expect(pipe.transform(undefined, query('search'))).toBeUndefined();
  });

  it('refuses a repeated key and a bracketed one', () => {
    expect(() => pipe.transform(['a', 'b'], query('search'))).toThrow(
      expect.objectContaining({ code: 'INVALID_QUERY_VALUE' }),
    );
    expect(() => pipe.transform({ x: '1' }, query('search'))).toThrow(
      expect.objectContaining({ code: 'INVALID_QUERY_VALUE' }),
    );
  });

  it('leaves a whole query object to its own schema, and every other argument alone', () => {
    const whole = { statuses: ['OPEN', 'DONE'] };
    expect(pipe.transform(whole, query(undefined))).toBe(whole);
    expect(pipe.transform(['a'], { type: 'body', data: undefined })).toEqual(['a']);
    expect(pipe.transform(['a'], { type: 'param', data: 'id' })).toEqual(['a']);
  });
});
