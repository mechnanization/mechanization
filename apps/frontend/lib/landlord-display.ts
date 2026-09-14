/**
 * Reading an owner match the way a clerk has to: two spellings side by side,
 * and a number that has to be read aloud.
 *
 * Nothing here decides anything. A name agreeing is not proof — brothers share
 * a surname and often a father's name, and a father and son can share all
 * three — so the comparison only ever *marks* a candidate; a person still
 * chooses, and the server still checks the number. What the marking removes is
 * the reconstruction: «ibrahim hashem nasrallah» typed on the tenant's card and
 * the same three words on a registered citizen used to sit in two different
 * boxes with nothing saying they were identical.
 */

/** How closely the name the tenant gave matches a registered citizen's. */
export type NameMatch =
  /** The same words once spelling variants are folded — `SAME` preselects. */
  | 'SAME'
  /** Most of the words agree — a shortened or fuller form of one name. */
  | 'SIMILAR'
  | 'DIFFERENT'
  /** One is Arabic and the other Latin; a person has to read both. */
  | 'OTHER_SCRIPT'
  /** The tenant gave no name. */
  | 'MISSING';

/**
 * The folding the server's `search_normalize` applies, restated for the page:
 * hamza-carrying alefs to bare alef, taa marbuta to haa, alef maqsura to yaa,
 * tashkeel and tatweel stripped, Latin lower-cased, everything else a space.
 */
function fold(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^a-zء-ي0-9]+/g, ' ')
    .trim();
}

function script(value: string): 'arabic' | 'latin' | null {
  if (/[ء-ي]/.test(value)) return 'arabic';
  if (/[a-z]/.test(value)) return 'latin';
  return null;
}

export function compareNames(typed: string | null | undefined, registered: string): NameMatch {
  const a = fold(typed ?? '');
  const b = fold(registered);
  if (!a) return 'MISSING';
  if (!b) return 'DIFFERENT';

  const scriptA = script(a);
  const scriptB = script(b);
  if (scriptA && scriptB && scriptA !== scriptB) return 'OTHER_SCRIPT';

  // «عبد الله» and «عبدالله» are one name written two ways.
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return 'SAME';

  const wordsA = a.split(' ');
  const wordsB = b.split(' ');
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const shared = shorter.filter((word) => longer.includes(word)).length;

  const firstAndLast =
    wordsA[0] === wordsB[0] && wordsA[wordsA.length - 1] === wordsB[wordsB.length - 1];
  if ((shorter.length >= 2 && shared === shorter.length) || firstAndLast) return 'SIMILAR';

  return 'DIFFERENT';
}

/**
 * A stored E.164 number, grouped for reading aloud: `+96170964631` →
 * `+961 70 964 631`. Always rendered inside `dir="ltr"` by the caller; the
 * grouping only inserts spaces, so copying it back into a form still parses.
 */
export function formatPhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  const lebanese = /^\+961(\d{7,8})$/.exec(digits);
  if (lebanese) {
    const local = lebanese[1]!;
    const head = local.length === 8 ? local.slice(0, 2) : local.slice(0, 1);
    const rest = local.slice(head.length);
    return `+961 ${head} ${rest.slice(0, 3)} ${rest.slice(3)}`;
  }
  const international = /^\+(\d{1,3})(\d+)$/.exec(digits);
  if (!international) return value;
  const groups = international[2]!.match(/.{1,3}/g) ?? [];
  return `+${international[1]} ${groups.join(' ')}`;
}
