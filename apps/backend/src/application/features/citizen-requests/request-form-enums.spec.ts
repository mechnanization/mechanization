import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REQUEST_ANSWER_ORIGIN,
  REQUEST_FIELD_TYPE,
  REQUEST_FORM_VERSION_STATUS,
  REQUEST_LINKED_SOURCE,
  REQUEST_LINKED_SOURCE_TYPE,
  REQUEST_PROPERTY_MODE,
  ar,
  en,
} from '@mechanization/shared-schemas';

/**
 * The request form enums in `@mechanization/shared-schemas` are the tenant schema's, value for value and in the
 * same order (migration 0112). A value added on one side only is a request the database refuses, or a screen that
 * cannot name what it was sent: this fails on the first drift.
 */
const PRISMA_SCHEMA = readFileSync(
  join(__dirname, '..', '..', '..', 'infrastructure', 'prisma', 'tenant', 'schema.prisma'),
  'utf8',
);

function prismaEnum(name: string): string[] {
  const match = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(PRISMA_SCHEMA);
  if (!match) throw new Error(`enum ${name} is not in the tenant schema`);
  return match[1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .map((line) => line.split(/\s+/)[0]!);
}

describe('request form enums match the tenant schema', () => {
  it.each([
    ['RequestFieldType', REQUEST_FIELD_TYPE],
    ['RequestPropertyMode', REQUEST_PROPERTY_MODE],
    ['RequestFormVersionStatus', REQUEST_FORM_VERSION_STATUS],
    ['RequestLinkedSource', REQUEST_LINKED_SOURCE],
    ['RequestAnswerOrigin', REQUEST_ANSWER_ORIGIN],
  ] as const)('%s', (name, values) => {
    expect(prismaEnum(name)).toEqual([...values]);
  });

  it('has an Arabic and an English label for every value', () => {
    const groups = [
      ['requestFieldType', REQUEST_FIELD_TYPE],
      ['requestPropertyMode', REQUEST_PROPERTY_MODE],
      ['requestFormVersionStatus', REQUEST_FORM_VERSION_STATUS],
      ['requestLinkedSource', REQUEST_LINKED_SOURCE],
      ['requestAnswerOrigin', REQUEST_ANSWER_ORIGIN],
    ] as const;
    for (const [group, values] of groups) {
      for (const value of values) {
        for (const locale of ['ar', 'en'] as const) {
          const text = ({ ar, en }[locale] as unknown as Record<string, Record<string, string>>)[group]?.[value];
          expect(typeof text === 'string' && text.length > 0).toBe(true);
        }
      }
    }
  });

  it('says which field type each linked source fills, for every source', () => {
    expect(Object.keys(REQUEST_LINKED_SOURCE_TYPE).sort()).toEqual([...REQUEST_LINKED_SOURCE].sort());
  });
});
