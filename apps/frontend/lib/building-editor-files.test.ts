import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  GOD-21 (cleanup sprint, 2026-11-24): the building editor was one file of 3,700
  lines. The audit's first criterion is that no file in its folder is over 600
  lines; this holds the folder to it while the function that is left in
  `building-editor.tsx` (phase 3: its state and effects into hooks) is taken apart.
*/
const FRONTEND = join(__dirname, '..');
const FOLDER = join(FRONTEND, 'components/admin/building-editor');
const lineCount = (path: string): number => readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;

describe('the building editor’s folder', () => {
  const files = readdirSync(FOLDER).filter((file) => /\.tsx?$/.test(file));

  it('holds the pieces the editor was split into', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files)('%s is no more than 600 lines', (file) => {
    expect(lineCount(join(FOLDER, file)), file).toBeLessThanOrEqual(600);
  });

  it('every component file is used by the editor, so none is left behind', () => {
    const editor = readFileSync(join(FRONTEND, 'components/admin/building-editor.tsx'), 'utf8');
    for (const file of files.filter((f) => f.endsWith('.tsx'))) {
      const name = file.replace(/\.tsx$/, '');
      const importedByAnother = files.some((other) => other !== file && readFileSync(join(FOLDER, other), 'utf8').includes(`'./${name}'`));
      expect(editor.includes(`'./building-editor/${name}'`) || importedByAnother, name).toBe(true);
    }
  });
});
