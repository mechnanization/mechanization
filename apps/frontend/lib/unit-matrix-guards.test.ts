import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  SUBMIT-02 (cleanup sprint, 2026-11-23): the unit matrix drawer, the unit
  picker and the shared visit/case helper wrote citizen occupancy, cases and
  visits with no guard beyond React's `busy` state — set asynchronously, so a
  double-click (or, for the drawer's three dialog-rethrowing handlers, no
  guard at all) could reach the server twice. Each write is now guarded by a
  ref (or, for the one plain shared function with no component of its own, a
  module-level flag) checked and set synchronously.

  Read, not rendered: the runner only collects `lib/**`.
*/
const COMPONENTS = join(__dirname, '..', 'components', 'admin');
const read = (file: string): string => readFileSync(join(COMPONENTS, file), 'utf8');

describe('the unit matrix drawer guards every write with a ref, checked before the state it also sets', () => {
  const drawer = read('building-unit-matrix-drawer.tsx');

  it('run() — createCase, updateUnit, deleteUnit, confirmVacancy, recordOccupancy, recordDamage, setUnitFeeExemption, setOwnerBilling, logUnitVisit', () => {
    expect(drawer).toMatch(/if \(runRef\.current\) return;\s*\n\s*runRef\.current = true;\s*\n\s*setBusy\(true\)/);
    expect(drawer).toMatch(/\} finally \{\s*\n\s*setBusy\(false\);\s*\n\s*runRef\.current = false;/);
  });

  it('addOnFloor() — addUnit', () => {
    expect(drawer).toMatch(/\|\| addingRef\.current\) return;\s*\n\s*\n?\s*addingRef\.current = true;\s*\n\s*setBusy\(true\)/);
    expect(drawer).toMatch(/setBusy\(false\);\s*\n\s*addingRef\.current = false;/);
  });

  it('liftVacancy, closeSpell, linkOwner — endVacancy, endOccupancy, linkOccupancyOwner (no busy state to race, so the ref alone guards each)', () => {
    for (const ref of ['endingVacancyRef', 'closingSpellRef', 'linkingOwnerRef']) {
      expect(drawer, ref).toMatch(new RegExp(`if \\(${ref}\\.current\\) return;\\s*\\n\\s*${ref}\\.current = true;`));
      expect(drawer, ref).toMatch(new RegExp(`\\} finally \\{\\s*\\n\\s*${ref}\\.current = false;`));
    }
  });
});

describe('logVisitWithFollowUp guards itself, since it is shared by two components and is not a hook', () => {
  const forms = read('building-unit-forms.tsx');

  it('checks and sets a module-level flag synchronously around logUnitVisit and createCase', () => {
    expect(forms).toMatch(/let visitInFlight = false;/);
    expect(forms).toMatch(/if \(visitInFlight\) throw new Error/);
    expect(forms).toMatch(/visitInFlight = true;[\s\S]{0,200}finally \{\s*\n\s*visitInFlight = false;/);
  });
});

describe('the unit picker guards submitNewUnit (addUnit) with a ref', () => {
  const picker = read('building-unit-picker.tsx');

  it('checks and sets addingRef synchronously, before the addingBusy state', () => {
    expect(picker).toMatch(/\|\| addingRef\.current\) return;/);
    expect(picker).toMatch(/addingRef\.current = true;\s*\n\s*setAddingBusy\(true\)/);
    expect(picker).toMatch(/setAddingBusy\(false\);\s*\n\s*addingRef\.current = false;/);
  });
});
