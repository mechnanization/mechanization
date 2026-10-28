import * as shared from '@mechanization/shared-schemas';
import { z } from 'zod';

/**
 * zod 4 fills in a field's `.default()` even when the field is optional, where
 * zod 3 left an absent key out. On a `.partial()` schema that turns "the caller
 * never sent it" into "the caller sent the default": an edit that never touched
 * `hasNoPhone` would reset it to `false`, one that never touched
 * `sharedRights` would clear them. `partialKeepingAbsent` builds those schemas
 * without the defaults; this fails if any exported schema holds an `optional`
 * around a `default` again.
 */
type Def = { type: string; [key: string]: unknown };
type Schema = { _zod: { def: Def } };

function optionalDefaults(root: unknown, name: string): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string, underOptional: boolean): void => {
    if (!node || typeof node !== 'object' || !('_zod' in node) || seen.has(node)) return;
    seen.add(node);
    const def = (node as Schema)._zod.def;
    switch (def.type) {
      case 'optional':
        return walk(def.innerType, path, true);
      case 'nullable':
      case 'readonly':
      case 'catch':
      case 'nonoptional':
      case 'prefault':
        return walk(def.innerType, path, underOptional);
      case 'default':
        if (underOptional) found.push(path);
        return walk(def.innerType, path, false);
      case 'object':
        for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) walk(value, `${path}.${key}`, false);
        return;
      case 'pipe':
        walk(def.in, path, underOptional);
        return walk(def.out, path, false);
      case 'array':
        return walk(def.element, `${path}[]`, false);
      case 'union':
        (def.options as unknown[]).forEach((option, index) => walk(option, `${path}|${index}`, underOptional));
        return;
      case 'intersection':
        walk(def.left, path, underOptional);
        return walk(def.right, path, underOptional);
      case 'record':
        return walk(def.valueType, `${path}{}`, false);
      case 'lazy':
        return walk((def.getter as () => unknown)(), path, underOptional);
      default:
        return;
    }
  };
  walk(root, name, false);
  return found;
}

describe('no shared schema fills in a default for a key the input left out', () => {
  it('finds the zod 4 trap where it is (control)', () => {
    const trap = z.object({ hasNoPhone: z.boolean().default(false) }).partial();
    expect(optionalDefaults(trap, 'trap')).toEqual(['trap.hasNoPhone']);
    expect(trap.parse({})).toEqual({ hasNoPhone: false });
  });

  it('partialKeepingAbsent leaves an absent key absent, and still parses a sent one', () => {
    const kept = shared.partialKeepingAbsent(z.object({ hasNoPhone: z.boolean().default(false) }));
    expect(optionalDefaults(kept, 'kept')).toEqual([]);
    expect(kept.parse({})).toEqual({});
    expect(kept.parse({ hasNoPhone: true })).toEqual({ hasNoPhone: true });
  });

  it('holds for every exported schema', () => {
    const found = Object.entries(shared).flatMap(([name, value]) => optionalDefaults(value, name));
    expect(found).toEqual([]);
  });
});
