import {
  NEWS_LANGUAGE,
  municipalInstant,
  saveNewsArticleSchema,
  type NewsArticleStatus,
  type NewsArticleView,
  type NewsLanguage,
} from '@mechanization/shared-schemas';

/**
 * The News article editor's form and its rules, apart from the screen.
 *
 * An article is written in up to three languages, the default one required.
 * Day3ati replaces the whole article on a save and removes a language that is
 * not sent, so the form holds all three and `toSaveInput` sends only the ones
 * that were written. Who may do what at each status is `actionsFor`: Day3ati
 * stays the authority and refuses what a status does not allow, but the screen
 * should not offer it.
 */

export interface ArticleTextDraft {
  title: string;
  summary: string;
  body: string;
}

export interface ArticleForm {
  categoryId: string;
  publisherId: string;
  defaultLanguage: NewsLanguage;
  texts: Record<NewsLanguage, ArticleTextDraft>;
  placeLabel: Record<NewsLanguage, string>;
  /** The quarter of the village. No screen sets it; it is carried so a save does not erase it. */
  areaId: string | null;
  notifyResidents: boolean;
}

const blankText = (): ArticleTextDraft => ({ title: '', summary: '', body: '' });

/** A new article: Arabic is the language it is written in unless the writer says otherwise. */
export function emptyArticleForm(defaultLanguage: NewsLanguage = 'ar'): ArticleForm {
  return {
    categoryId: '',
    publisherId: '',
    defaultLanguage,
    texts: { ar: blankText(), en: blankText(), fr: blankText() },
    placeLabel: { ar: '', en: '', fr: '' },
    areaId: null,
    notifyResidents: false,
  };
}

/** The form for an article on file. A language it does not have is blank. */
export function formFromView(view: NewsArticleView): ArticleForm {
  const form = emptyArticleForm(view.defaultLanguage);
  for (const text of view.texts) {
    form.texts[text.language] = { title: text.title, summary: text.summary, body: text.body };
  }
  form.categoryId = view.categoryId;
  form.publisherId = view.publisherId;
  form.placeLabel = {
    ar: view.placeLabel?.ar ?? '',
    en: view.placeLabel?.en ?? '',
    fr: view.placeLabel?.fr ?? '',
  };
  form.areaId = view.areaId;
  form.notifyResidents = view.notifyResidents;
  return form;
}

const written = (text: ArticleTextDraft): boolean =>
  text.title.trim() !== '' || text.summary.trim() !== '' || text.body.trim() !== '';

/**
 * What the form sends: the default language always, another only once something
 * is written in it (and then all of it is checked, so half a translation is
 * refused rather than saved).
 */
export function toSaveInput(form: ArticleForm): unknown {
  return {
    categoryId: form.categoryId,
    publisherId: form.publisherId,
    defaultLanguage: form.defaultLanguage,
    texts: NEWS_LANGUAGE.filter((language) => language === form.defaultLanguage || written(form.texts[language])).map(
      (language) => ({ language, ...form.texts[language] }),
    ),
    placeLabelAr: form.placeLabel.ar,
    placeLabelEn: form.placeLabel.en,
    placeLabelFr: form.placeLabel.fr,
    areaId: form.areaId,
    notifyResidents: form.notifyResidents,
  };
}

/** Why a field is refused: nothing in it, or too much. The screen words each. */
export type ArticleFieldProblem = 'required' | 'tooLong';

/**
 * The fields the shared schema refuses, keyed as the form names them:
 * `categoryId`, `publisherId`, `title.ar`, `summary.en`, `body.fr`,
 * `placeLabel.ar`. Empty when the form can be sent.
 */
export function articleFormErrors(form: ArticleForm): Record<string, ArticleFieldProblem> {
  const input = toSaveInput(form) as { texts: { language: NewsLanguage }[] };
  const parsed = saveNewsArticleSchema.safeParse(input);
  if (parsed.success) return {};

  const errors: Record<string, ArticleFieldProblem> = {};
  for (const issue of parsed.error.issues) {
    const problem: ArticleFieldProblem = issue.code === 'too_big' ? 'tooLong' : 'required';
    const [head, index, field] = issue.path;
    if (head === 'texts' && typeof index === 'number' && typeof field === 'string') {
      const language = input.texts[index]?.language;
      if (language) errors[`${field}.${language}`] ??= problem;
    } else if (head === 'texts') {
      // The default language's text is missing altogether: it is the one thing every article needs.
      errors[`title.${form.defaultLanguage}`] ??= 'required';
      errors[`body.${form.defaultLanguage}`] ??= 'required';
    } else if (head === 'placeLabelAr' || head === 'placeLabelEn' || head === 'placeLabelFr') {
      errors[`placeLabel.${head.slice('placeLabel'.length).toLowerCase()}`] ??= problem;
    } else if (typeof head === 'string') {
      errors[head] ??= problem;
    }
  }
  return errors;
}

/** Two forms with the same fingerprint have nothing between them to save. */
export function formFingerprint(form: ArticleForm): string {
  return JSON.stringify(toSaveInput(form));
}

export type ArticleAction =
  | 'save'
  | 'publishNow'
  | 'schedule'
  | 'cancelSchedule'
  | 'archive'
  | 'publishAgain'
  | 'placement'
  | 'delete';

/**
 * What an article's status lets the editor offer (an article not yet saved has
 * only «save»). A draft is published or scheduled; a scheduled one is published
 * now, moved, or sent back to a draft; a published one is archived or placed in
 * the feed, never scheduled (Day3ati refuses: `news.already_published`); an
 * archived one is published again. Any can be saved and deleted.
 */
export function actionsFor(status: NewsArticleStatus | null): readonly ArticleAction[] {
  switch (status) {
    case null:
      return ['save'];
    case 'draft':
      return ['save', 'publishNow', 'schedule', 'delete'];
    case 'scheduled':
      return ['save', 'publishNow', 'schedule', 'cancelSchedule', 'delete'];
    case 'published':
      return ['save', 'archive', 'placement', 'delete'];
    case 'archived':
      return ['save', 'publishAgain', 'delete'];
  }
}

/** A schedule must be at least this far ahead; Day3ati decides what it will take, this is only the screen's floor. */
export const SCHEDULE_MIN_LEAD_MS = 60_000;

export type ScheduleResult = { ok: true; iso: string } | { ok: false; reason: 'incomplete' | 'past' };

/**
 * The instant a schedule picked on the municipality's clock is, as Day3ati takes
 * it (UTC). «1 December, 08:00» in Beirut is `2026-12-01T06:00:00.000Z`.
 */
export function scheduleInstant(day: string, time: string, now: Date = new Date()): ScheduleResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return { ok: false, reason: 'incomplete' };
  const instant = municipalInstant(day, time);
  if (Number.isNaN(instant.getTime())) return { ok: false, reason: 'incomplete' };
  if (instant.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) return { ok: false, reason: 'past' };
  return { ok: true, iso: instant.toISOString() };
}
