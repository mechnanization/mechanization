import { internationalPhone } from '@mechanization/shared-schemas';

/**
 * رقم الهاتف — accepted from anywhere, stored one way.
 *
 * `lebanesePhone` refused every number that was not on a Lebanese network, and
 * the register is full of people who are not: an owner in Abidjan whose flat is
 * let here, the relative a شاغل بتسامح names as their landlord, a family still
 * carrying the number they lived on abroad. A required field that refuses the
 * true answer does not collect a better one — it collects an invented one, or
 * an «غير مؤكَّد» flag on every such record until the flag means nothing.
 *
 * Two properties are load-bearing and each has its own half of this file:
 *
 *  1. **Lebanon is still the unstated default.** A bare `71123456` is Lebanese,
 *     exactly as it always was. Nobody typing an ordinary local number types a
 *     country code, and making them would slow every registration in the
 *     municipality to accommodate the rare foreign one.
 *  2. **The local branch stays strict.** A mistyped Lebanese number is by far
 *     the commonest error on this form, and loosening the no-country-code case
 *     to "any 8–15 digits" would stop catching it. Widening the rule must not
 *     cost the check that earns its keep every day.
 *
 * Storage is E.164 with a leading `+` throughout — unchanged — so
 * `@@index([kind, phone])`, the `searchText` generated column and every row
 * already written keep working. This widens what is *accepted*; it changes
 * nothing about what is stored for anything that was accepted before.
 */
describe('internationalPhone', () => {
  const parse = (input: string) => internationalPhone.safeParse(input);

  describe('Lebanese numbers need no country code', () => {
    const cases: Array<[string, string, string]> = [
      ['71123456', '+96171123456', 'a bare mobile, which is how they are written'],
      ['03123456', '+9613123456', 'the 03 prefix, six digits not seven'],
      ['071123456', '+96171123456', 'a leading zero, as dialled inside Lebanon'],
      ['+961 71 123456', '+96171123456', 'spaces and an explicit code'],
      ['0096171123456', '+96171123456', 'the 00 form of the same'],
      ['٧١١٢٣٤٥٦', '+96171123456', 'Arabic-Indic digits, which phones in this municipality produce'],
      ['81123456', '+96181123456', 'the 81 prefix'],
    ];

    for (const [input, expected, why] of cases) {
      it(`${input} → ${expected} — ${why}`, () => {
        const result = parse(input);
        expect(result.success && result.data).toBe(expected);
      });
    }
  });

  describe('any other country, marked by + or 00', () => {
    const cases: Array<[string, string, string]> = [
      ['+33 6 12 34 56 78', '+33612345678', 'France — an owner abroad'],
      ['+1 (415) 555-0123', '+14155550123', 'punctuation people actually type'],
      ['00225 07 12 34 56 78', '+2250712345678', 'Abidjan, reached through 00'],
      ['+61 412 345 678', '+61412345678', 'Australia'],
      ['+963 944 123 456', '+963944123456', 'Syria — the commonest of these in practice'],
    ];

    for (const [input, expected, why] of cases) {
      it(`${input} → ${expected} — ${why}`, () => {
        const result = parse(input);
        expect(result.success && result.data).toBe(expected);
      });
    }
  });

  describe('still refuses what it always refused', () => {
    /*
      The half that would be silently lost by "just make the regex looser".
      Every row here parses fine under an any-digits rule and is a wrong number
      that would have gone into the register unchallenged.
    */
    const cases: Array<[string, string]> = [
      ['12345', 'far too short to be anybody'],
      ['999123456', 'right length, not a Lebanese mobile prefix'],
      ['9123456', 'a landline-shaped number in a mobile field'],
      ['+123', 'below E.164’s floor'],
      ['+1234567890123456', 'above E.164’s ceiling of 15'],
      ['abc', 'not a number at all'],
      ['003123456', 'a local 03 mistyped as international — refused, not mangled'],
      ['', 'empty'],
    ];

    for (const [input, why] of cases) {
      it(`rejects ${JSON.stringify(input)} — ${why}`, () => {
        expect(parse(input).success).toBe(false);
      });
    }
  });

  it('is idempotent — re-parsing a stored value returns it unchanged', () => {
    /*
      Not a curiosity. An edit loads the stored `+961…` back into the form and
      saves it again, so a rule that only accepted what a person types would
      reject the register's own output the second time somebody corrected a
      surname.
    */
    for (const stored of ['+96171123456', '+33612345678', '+14155550123']) {
      const once = parse(stored);
      expect(once.success && once.data).toBe(stored);
    }
  });
});
