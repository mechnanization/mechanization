import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  ERR-02 (cleanup sprint, 2026-11-24): a read made beside the main one used to
  swallow its failure with `.catch(() => null)`, and the screen drew the empty
  answer as a fact — a building with no damage log as undamaged, a parcel whose
  check failed as a clean result, a registration whose case could
  not be read as one opened from nothing.

  Read, not rendered (the runner collects `lib/**` only).
*/
const ADMIN = join(__dirname, '..', 'components', 'admin');
const read = (file: string): string => readFileSync(join(ADMIN, file), 'utf8');

describe('a failed side read is said, not shown as «nothing there»', () => {
  it.each([
    'building-unit-matrix-view.tsx',
    'building-unit-matrix-drawer.tsx',
  ])('%s: the damage log failing is a flag beside the history, with a retry that reads the log alone', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/getBuildingDamage\([^)]*\)\.catch\(\(\) => null\)/);
    expect(source).toMatch(/setDamageFailed\(condition === 'FAILED'\)/);
    expect(source).toMatch(/\{damageFailed \? <DamageReadFailed onRetry=\{\(\) => void retryDamage\(\)\} \/> : null\}/);
    // The retry re-reads the log only, so a form open on the matrix is not unmounted.
    expect(source).toMatch(/const retryDamage = useCallback\(async \(\) => \{[\s\S]{0,200}getBuildingDamage\(/);
  });

  it('the damage notice is the shared «last read failed» alert, with a retry', () => {
    expect(read('damage/damage-read-failed.tsx')).toMatch(/<RefreshFailedAlert[^>]*onRetry=\{onRetry\}/);
  });

  it('building-editor: a failed property-number check is a hint, not a clean result', () => {
    const source = read('building-editor/use-parcel-lookup.ts');
    expect(source).not.toMatch(/checkPropertyNumber\([^)]*\)\.catch\(\(\) => null\)/);
    expect(source).toMatch(/check === null\s*\n\s*\? tEditor\('cadastreUnchecked'\)/);
  });

  it('citizen-editor: a case or building that could not be read is announced above the blank form', () => {
    const source = read('citizen-editor.tsx');
    expect(source).not.toMatch(/getCase\([^)]*\)\.catch\(\(\) => null\)/);
    expect(source).not.toMatch(/getBuilding\([^)]*\)\.catch\(\(\) => null\)/);
    expect(source).toMatch(/unread\.push\('case'\)/);
    expect(source).toMatch(/unread\.push\('building'\)/);
    expect(source).toMatch(/setUnreadSources\(unread\)/);
    expect(source).toMatch(/unreadSources\.length > 0/);
  });
});
