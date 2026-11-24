import { csvCell } from '@mechanization/shared-schemas';

/*
  The formula-injection guard every CSV this system writes goes through: the
  server's citizen export (`ReportingService`) and every sheet the portal builds
  (`apps/frontend/lib/csv.ts`). It lives in shared-schemas, which has no test
  runner, so its spec is here (DRY-04).
*/
describe('csvCell', () => {
  it.each([
    ['=SUM(A1:A9)', `"'=SUM(A1:A9)"`],
    ['+961 3 123 456', `"'+961 3 123 456"`],
    ['-1+1', `"'-1+1"`],
    ['@cmd', `"'@cmd"`],
    ['\t=1', `"'\t=1"`],
    ['\r=1', `"'\r=1"`],
  ])('neutralises a value that opens with a formula trigger: %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('leaves an ordinary value as it is, quoted', () => {
    expect(csvCell('أحمد محمد')).toBe('"أحمد محمد"');
    expect(csvCell('A2-1854')).toBe('"A2-1854"');
    expect(csvCell('1=1')).toBe('"1=1"');
  });

  it('doubles a quote inside the value, after the guard', () => {
    expect(csvCell('the "old" books')).toBe('"the ""old"" books"');
    expect(csvCell('="1"')).toBe(`"'=""1"""`);
  });

  it('keeps a comma and a line break inside the one quoted cell', () => {
    expect(csvCell('Zahle, Bekaa')).toBe('"Zahle, Bekaa"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes an absent value as an empty cell and a number as its text', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(-5)).toBe(`"'-5"`);
  });
});
