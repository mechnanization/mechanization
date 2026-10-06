import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { argumentNames, tagNames } from './icu-arguments';

/*
  Both locales are complete (root rule 9): every message the Arabic screen
  reads exists in English with the same placeholders, and the reverse. Before
  this, only `errors.*` was checked, so a key added to one file and forgotten in
  the other rendered as its raw key path on the other locale's screen.
*/

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [inner, text] of leaves(value, path)) out.set(inner, text);
  }
  return out;
}

describe('the message files', () => {
  const arabic = leaves(ar as Tree);
  const english = leaves(en as Tree);

  it('hold the same keys in both locales', () => {
    expect([...arabic.keys()].filter((key) => !english.has(key))).toEqual([]);
    expect([...english.keys()].filter((key) => !arabic.has(key))).toEqual([]);
  });

  it('give each message the same placeholders in both locales', () => {
    const mismatched = [...arabic.entries()]
      .filter(([key]) => english.has(key))
      .filter(([key, text]) => argumentNames(text).join(',') !== argumentNames(english.get(key)!).join(','))
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  /*
    A count inside a plural branch is written `{count}`, never `#`. In a
    component, `#` is formatted with the page's locale, and plain `ar` prints
    Arabic-Indic digits on some engines (`ar-LB` does on Node 26) while every
    other figure on the portal is Latin; `{count}` is inserted as written.
    `errors.*` is read through `api-errors.ts`, whose locale pins Latin digits.
  */
  it('write Arabic counts as {count}, never #, outside errors', () => {
    const pound = [...arabic.entries()]
      .filter(([key, text]) => !key.startsWith('errors.') && text.includes('#'))
      .map(([key]) => key);
    expect(pound).toEqual([]);
  });

  it('give each message the same rich-text tags in both locales', () => {
    const mismatched = [...arabic.entries()]
      .filter(([key]) => english.has(key))
      .filter(([key, text]) => tagNames(text).join(',') !== tagNames(english.get(key)!).join(','))
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});
