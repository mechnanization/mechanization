import { describe, expect, it } from 'vitest';
import { duplexMergeBlockerRefusal, ERROR_CODES, unitCorrectionBlockerRefusal } from '@mechanization/shared-schemas';
import en from '../messages/en.json';
import { localizeApiError } from './api-errors';
import { argumentNames } from './icu-arguments';

/*
  ERR-04: the refusals a preview's blocks carry (a landlord link, «دمج ملفين»
  and its undo, «حذف تصحيحي», «دمج كدوبلكس») are worded from the message files,
  so an English page shows no server Arabic. ERR-05 renders the previews from
  them; until then these pin that the words are there, in both branches of
  every select.
*/
const BLOCK_CODE = /^(LANDLORD_LINK_(NOT_ON_SURVEY|NO_UNITS|UNIT_VACANT|OWNER_|UNIT_OWNED|RECONCILE)|MERGE_(SAME|FILE_|PERSON|ROLE|LINK|SELF|TOO|ESTATE|KEPT)|UNMERGE_|UNIT_CORRECTION_(DAMAGE|LINK|UNREADABLE)|DUPLEX_MERGE_(?!NO_UPPER|BLOCKED))/;
const blockCodes = ERROR_CODES.filter((code) => BLOCK_CODE.test(code));
const ARABIC = /[؀-ۿ]/;
const enErrors = en.errors as Record<string, string>;

/** Latin values for every argument: `has*` set to `answer`, roles and kinds to an unknown value. */
function values(code: string, answer: 'yes' | 'no'): Record<string, string | number> {
  return Object.fromEntries(
    argumentNames(enErrors[code]!).map((name) => [name, name.startsWith('has') ? answer : name === 'count' || name === 'max' ? 2 : 'X1']),
  );
}

describe('the block refusals (ERR-04)', () => {
  it('are the 37 codes the previews send', () => {
    expect(blockCodes).toHaveLength(37);
  });

  it.each(blockCodes)('%s reads in English with no Arabic, whatever the selects choose', (code) => {
    for (const answer of ['yes', 'no'] as const) {
      const text = localizeApiError({ code, message: 'نص الخادم', params: values(code, answer) }, 'en');
      expect(text).not.toMatch(ARABIC);
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it('words a role and a missing label', () => {
    const conflict = {
      code: 'MERGE_ROLE_CONFLICT_ON_CARDS',
      params: { hasLabel: 'yes', label: 'A2-101', keptRole: 'OWNER', otherRole: 'TENANT' },
    };
    expect(localizeApiError({ ...conflict, message: 'x' }, 'en')).toBe(
      'A2-101: one file records the person as owner and the other as tenant. Correct the wrong card in its file first, then merge.',
    );
    expect(localizeApiError({ ...conflict, message: 'x' }, 'ar')).toMatch(/^A2-101: أحد الملفين يسجّله مالكاً والآخر مستأجراً\./);
    const unlabelled = { code: 'MERGE_LINK_WROTE_CARD', message: 'x', params: { hasLabel: 'no', label: '' } };
    expect(localizeApiError(unlabelled, 'en')).toMatch(/^A property: /);
  });

  it('words a landlord link block with and without its unit', () => {
    const owned = { hasUnit: 'yes', unitCode: '0102', hasOwners: 'yes', owners: 'ندى' };
    expect(localizeApiError({ code: 'LANDLORD_LINK_UNIT_OWNED_BY_OTHER', message: 'x', params: owned }, 'en')).toMatch(
      /^Unit 0102 has an owner in the building register \(ندى\) and this citizen/,
    );
    const bare = { hasUnit: 'no', unitCode: '', hasOwners: 'no', owners: '' };
    expect(localizeApiError({ code: 'LANDLORD_LINK_UNIT_VACANT', message: 'x', params: bare }, 'ar')).toMatch(/^الوحدة مؤكَّد شغورها/);
  });

  it('gives every unit-correction and duplex blocker a code the dictionaries word', () => {
    const blockers = [
      unitCorrectionBlockerRefusal({ kind: 'DAMAGE_ASSESSMENT', count: 1 }),
      unitCorrectionBlockerRefusal({ kind: 'LINK_NAMES_OTHER_UNITS', citizenName: 'X' }),
      duplexMergeBlockerRefusal({ kind: 'TOO_MANY_LEVELS', max: 3 }),
      duplexMergeBlockerRefusal({ kind: 'AREA_UNKNOWN' }),
      duplexMergeBlockerRefusal({ kind: 'UNREADABLE_LANDLORD_LINK', citizenName: 'X' }),
    ];
    for (const refusal of blockers) {
      expect(localizeApiError({ ...refusal, message: 'SERVER' }, 'en')).not.toBe('SERVER');
    }
    expect(localizeApiError({ ...duplexMergeBlockerRefusal({ kind: 'TOO_MANY_LEVELS', max: 3 }), message: 'x' }, 'en')).toBe(
      'The two units cannot be merged as a duplex: a home spans at most 3 levels.',
    );
  });
});
