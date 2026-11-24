import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  GOD-21, phase 3 (cleanup sprint, 2026-11-24): the building editor's 26 pieces of
  state and 13 effects live in seven hooks, called from `BuildingEditor` where the
  code used to be. A hook moved out of a component runs its effects in the order
  it is called, so the order is the contract: this reads the sources and pins it,
  with what the audit says must survive the split (the in-flight guard and the
  held creation key). `building-editor-dom.test.ts` runs the behaviour.
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8').replace(/\r\n/g, '\n');

const editor = read('components/admin/building-editor.tsx');
const HOOKS = [
  ['useBuildingFields', 'use-building-fields.ts', 0],
  ['useEditorDraft', 'use-editor-draft.ts', 2],
  ['useBuildingLoad', 'use-building-load.ts', 2],
  ['useParcelLookup', 'use-parcel-lookup.ts', 2],
  ['useStructureRules', 'use-structure-rules.ts', 5],
  ['useStepGates', 'use-step-gates.ts', 0],
  ['useBuildingSave', 'use-building-save.ts', 1],
] as const;
const hook = (file: string): string => read(`components/admin/building-editor/${file}`);
const count = (source: string, needle: RegExp): number => (source.match(needle) ?? []).length;

describe('the editor calls its hooks in the order the code ran them', () => {
  it('fields, draft, load, lookup, rules, gates, save', () => {
    let from = -1;
    for (const [name] of HOOKS) {
      const at = editor.indexOf(`${name}(`, from + 1);
      expect(at, name).toBeGreaterThan(from);
      from = at;
    }
  });

  it('the role redirect, which is the editor’s own effect, runs before every hook that was after it', () => {
    expect(editor.indexOf('useEffect(')).toBeLessThan(editor.indexOf('useBuildingFields('));
    expect(count(editor, /useEffect\(/g)).toBe(1);
  });
});

describe('the thirteen effects are all still there, each in the hook it was moved to', () => {
  it.each(HOOKS)('%s holds %i effect(s)', (name, file, effects) => {
    expect(count(hook(file), /useEffect\(/g), name).toBe(effects);
  });

  it('thirteen in all, as before the split', () => {
    const total = HOOKS.reduce((sum, [, file]) => sum + count(hook(file), /useEffect\(/g), 0) + count(editor, /useEffect\(/g);
    expect(total).toBe(13);
  });

  it('twenty-six pieces of state and refs, all in the fields hook and the load hook', () => {
    const states = (source: string) => count(source, /\buse(?:State|Ref)\(|\buse(?:State|Ref)</g);
    const total = HOOKS.reduce((sum, [, file]) => sum + states(hook(file)), 0) + states(editor);
    expect(total).toBeGreaterThanOrEqual(26);
  });
});

describe('the draft: restored once before anything is written', () => {
  const draft = hook('use-editor-draft.ts');

  it('the restore runs first and marks itself done, then the autosave', () => {
    const restore = draft.indexOf('if (restoredRef.current) return;\n    restoredRef.current = true;');
    const autosave = draft.indexOf('if (!restoredRef.current) return;');
    expect(restore, 'the restore').toBeGreaterThan(-1);
    expect(autosave, 'the autosave').toBeGreaterThan(restore);
  });

  it('an edit is written only once it differs from the building as loaded', () => {
    expect(draft).toMatch(/editDraftFingerprint\(draft\) === pristineRef\.current/);
  });
});

describe('what the audit says must survive: the in-flight guard and the held key', () => {
  const save = hook('use-building-save.ts');

  it('the guard is checked first and set before the busy state, and a landed save never releases it', () => {
    expect(save).toMatch(/if \(inFlight\.current\) return;/);
    expect(save.indexOf('inFlight.current = true;')).toBeLessThan(save.indexOf('setSaving(true);'));
    expect(save).toMatch(/if \(!landed\) \{\n\s+inFlight\.current = false;\n\s+setSaving\(false\);/);
  });

  it('a creation goes out under the key held for its parcel, online and through the queue', () => {
    expect(save).toMatch(/clientSubmissionId: heldKey\(tenant, creationScope\)/);
    expect(save).toMatch(/id: heldKey\(tenant, creationScope\)/);
    expect(save).toMatch(/\.\.\.\(heldInDoubt\(tenant, creationScope\) \? \{ afterLostAnswer: true \} : \{\}\)/);
  });

  it('the key is spent when the building is on file or queued, kept across a refusal, marked in doubt on a lost answer', () => {
    expect(count(save, /spendKey\(tenant, creationScope\)/g)).toBe(3);
    expect(save).toMatch(/if \(keyIsSpent\(caught\)\) spendKey\(tenant, creationScope\);\n\s+else if \(outcomeInDoubt\(caught\)\) markInDoubt\(tenant, creationScope\);/);
  });

  it('the scope is the parcel, trimmed, and is built where the state is (not in the save)', () => {
    expect(hook('use-building-fields.ts')).toMatch(/const creationScope = `building:\$\{parcelNumber\.trim\(\)\}` as const;/);
  });

  it('a correction is rehearsed first, with the version it was made against', () => {
    expect(save).toMatch(/\{ \.\.\.save, dryRun: true \}/);
    expect(save).toMatch(/if \(!confirmed\) \{/);
  });
});

describe('the load keeps a restored draft over the server’s copy, and asks when someone else saved', () => {
  const load = hook('use-building-load.ts');

  it('the draft is kept on load, and the stale one is put to the officer', () => {
    expect(load).toMatch(/const keepEdits = draftRestoredRef\.current;/);
    expect(load).toMatch(/hydrate\(detail, keepEdits\);/);
    expect(load).toMatch(/setStaleDraft\(detail\);/);
  });
});
