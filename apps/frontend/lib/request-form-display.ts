import type { RequestAnswerView, RequestMissingPaper } from '@mechanization/shared-schemas';

/**
 * How an answer on a request reads on a screen (docs/request-forms-plan.md §6): staff's panel and the citizen's own request
 * page. A choice is shown in the words the version gave it (`display`), yes and no
 * are said in the page's language, a list of choices is joined, a number is left as it was written.
 */
export function answerText(
  answer: Pick<RequestAnswerView, 'value' | 'type' | 'display'>,
  locale: string,
  yes: string,
  no: string,
): string {
  const { value, type, display } = answer;
  if (display) return locale === 'en' && display.en ? display.en : display.ar;
  if (typeof value === 'boolean') return value ? yes : no;
  if (Array.isArray(value)) return value.join('، ');
  if (type === 'DATE' || typeof value === 'number') return String(value);
  return value;
}

/** A file question's words in the page's language, falling back to Arabic; an empty string where the question is unknown. */
export function questionName(paper: Pick<RequestMissingPaper, 'labelAr' | 'labelEn'> | undefined, locale: string): string {
  if (!paper) return '';
  return locale === 'en' && paper.labelEn ? paper.labelEn : paper.labelAr;
}
