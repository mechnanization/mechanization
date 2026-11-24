import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  GOD-22, phase 2c (cleanup sprint, 2026-11-24): the citizen form's state and
  effects live in three hooks and its dialogs in one component. This file reads
  the sources for what a move could silently change: the order effects run in,
  what the draft write depends on, the order the hooks are called in, and the
  order of the dialogs. `citizen-form-dom.test.ts` runs the form in jsdom and
  checks the behaviour; this stays because it names the order, which a
  behaviour test can only notice when it happens to matter.
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8').replace(/\r\n/g, '\n');

const form = read('components/admin/citizen-form.tsx');
const record = read('components/admin/citizen-form/use-citizen-form-record.ts');
const residence = read('components/admin/citizen-form/use-residence-change.ts');
const wizard = read('components/admin/citizen-form/use-citizen-form-wizard.ts');
const dialogs = read('components/admin/citizen-form/citizen-form-dialogs.tsx');

const inOrder = (source: string, markers: string[]): void => {
  let from = -1;
  for (const marker of markers) {
    const at = source.indexOf(marker, from + 1);
    expect(at, `${marker} (after the one before it)`).toBeGreaterThan(from);
    from = at;
  }
};

describe('the record hook keeps the four effects in the order they ran in', () => {
  it('re-seed, tell the parent, clear a disallowed type, withdraw an unasked flag', () => {
    inOrder(record, [
      '}, [initial]);',
      '}, [values]);', // the draft write
      '}, [allowedTypes, values.properties]);',
      "setValues((current) => withUnaskableFlagsDropped(current, askable));\n  }, [values]);",
    ]);
    expect(record.match(/useEffect\(/g)).toHaveLength(4);
  });

  it('the parent is told through a ref and on `values` alone, so an inline callback does not write a draft per render', () => {
    expect(record).toMatch(/const notifyChange = useRef\(onValuesChange\);\n {2}notifyChange\.current = onValuesChange;/);
    expect(record).toMatch(/useEffect\(\(\) => \{\n {4}notifyChange\.current\?\.\(values\);\n {2}\}, \[values\]\);/);
  });

  it('a saved card opens folded and a new one expanded, and a record that loads late replaces what is shown', () => {
    expect(record).toMatch(/setValues\(initial\);/);
    expect(record).toMatch(/initial\.properties\.flatMap\(\(property, index\) => \(property\.id \? \[index\] : \[\]\)\)/);
  });

  it('adding a card folds the others from inside the same update, as it did', () => {
    expect(record).toMatch(/const next = withAddedProperty\(current, sameParcelAs\);\n {6}setCollapsed\(collapsedAfterAdd\(next\.properties\)\);\n {6}return next;/);
  });

  it('removing a card shifts the folded set in the same call', () => {
    expect(record).toMatch(
      /setValues\(\(current\) => withRemovedProperty\(current, index, answer\)\);\n {4}setCollapsed\(\(current\) => collapsedAfterRemoval\(current, index\)\);/,
    );
  });
});

describe('the form calls its hooks in the order the code ran them', () => {
  it('record, then residence, then the duplicate lookup, then the wizard', () => {
    inOrder(form, ['useCitizenFormRecord({', 'useResidenceChange({', 'usePossibleDuplicates({', 'useCitizenFormWizard({']);
  });

  it('the wizard is told the errors’ verdict (sectionInvalid) from the form, and the form still decides where an error lands', () => {
    expect(form).toMatch(/useCitizenFormWizard\(\{ values, locale, nonPerson, isNonResident, tKind, sectionInvalid \}\)/);
    expect(form).toMatch(/setReviewing\(false\);\n {6}setStep\(firstInvalidSection\.id as SectionId\);/);
  });
});

describe('the residence move is remembered before it is applied (what «تراجع» restores)', () => {
  it('applyMove keeps the form as it stood, then applies the planned move, then closes the guide', () => {
    expect(residence).toMatch(
      /beforeMove\.current = values;\n {4}setValues\(applyResidenceMove\(values, planResidenceMove\(values, to\), answers\)\);\n {4}setResidenceGuide\(null\);/,
    );
  });

  it('correctResidence switches without recording a move, and undoing restores the snapshot', () => {
    expect(residence).toMatch(/\{ \.\.\.withResidence\(current, to\), residenceMove: undefined \}/);
    expect(residence).toMatch(/const snapshot = beforeMove\.current;\n {4}beforeMove\.current = null;\n {4}if \(snapshot\) setValues\(snapshot\);/);
  });

  it('only a move on a saved file opens the guide; a new filing just answers the question', () => {
    expect(residence).toMatch(/if \(mode === 'edit' && citizenId && guided\) \{\n {8}setResidenceGuide\(next\);/);
  });
});

describe('the dialogs keep their order and their handlers', () => {
  it('the quick save, the roster, «خانات غير مؤكَّدة», «دمج» and «تغيير الإقامة», in that order', () => {
    inOrder(dialogs, ['<QuickSaveDialog', '<ParcelRosterDialog', '<UnverifiedFieldsDialog', '<MergeCitizensDialog', '<ResidenceChangeDialog']);
  });

  it('a newly flagged field is emptied by the dialog’s save, the same rule as raising one', () => {
    expect(dialogs).toMatch(/onSaveFlags=\{\(newFlags\) => setValues\(\(current\) => withFlagsApplied\(current, newFlags\)\)\}/);
  });

  it('the guide’s two answers are the hook’s, and a deactivation closes the guide first', () => {
    expect(dialogs).toMatch(/onCorrect=\{\(\) => correctResidence\(residenceGuide\)\}/);
    expect(dialogs).toMatch(/onApply=\{\(answers\) => applyMove\(residenceGuide, answers\)\}/);
    expect(dialogs).toMatch(/onDeactivated=\{\(\) => \{\n\s+setResidenceGuide\(null\);\n\s+onDeactivated\?\.\(\);/);
  });

  it('the form draws them inside the flag provider, after the page', () => {
    inOrder(form, ['<FieldFlagProvider value={flagging}>', '<DesktopActionBar', '<CitizenFormDialogs', '</FieldFlagProvider>']);
  });
});

describe('the wizard hook keeps what makes a step change safe', () => {
  it('every page stays mounted: the form hides, never unmounts, a page that is not shown', () => {
    expect(form).toMatch(/cn\(!reviewing && step !== 'personal' && 'hidden'\)/);
    expect(form).toMatch(/cn\(!reviewing && step !== 'contact' && 'hidden'\)/);
    expect(form).toMatch(/!reviewing && step !== 'properties' && 'hidden'/);
  });

  it('a step change scrolls the form’s own root back to the top, not the window', () => {
    expect(wizard).toMatch(/scrollElementToTop\(formRootRef\.current\)/);
    // (the hook's comment still names `window.scrollTo`, which once did nothing here; a call is what must not return)
    expect(wizard).not.toMatch(/window\.scrollTo\(/);
  });

  it('the fourth step opens on the paths flagged at that moment, and later ones join them', () => {
    expect(wizard).toMatch(/setReviewPaths\(new Set\(values\.flags\.keys\(\)\)\)/);
    expect(wizard).toMatch(/paths: new Set\(\[\.\.\.reviewPaths, \.\.\.values\.flags\.keys\(\)\]\)/);
  });
});
