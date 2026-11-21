'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  NEWS_BODY_MAX,
  NEWS_LANGUAGE,
  NEWS_PLACE_LABEL_MAX,
  NEWS_SUMMARY_MAX,
  NEWS_TITLE_MAX,
  type NewsCategoryView,
  type NewsLanguage,
  type NewsPublisherView,
} from '@mechanization/shared-schemas';
import { newsName } from '@/lib/news';
import type { ArticleFieldProblem, ArticleForm, ArticleTextDraft } from '@/lib/news-article-form';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const LIMITS = { title: NEWS_TITLE_MAX, summary: NEWS_SUMMARY_MAX, body: NEWS_BODY_MAX } as const;

/** The text direction each language is written in. */
const DIRECTION: Record<NewsLanguage, 'rtl' | 'ltr'> = { ar: 'rtl', en: 'ltr', fr: 'ltr' };

/**
 * The form of a News article: its text in up to three languages, then the
 * details (category, publisher, place, notify). It holds no state of its own
 * beyond the language tab being looked at; the form belongs to the editor.
 * `errors` come from `articleFormErrors` and are shown only once the writer has
 * tried to save, so a blank form is not red before it is touched.
 */
export function ArticleFields({
  tenantBase,
  locale,
  form,
  errors,
  categories,
  publishers,
  disabled,
  onChange,
}: {
  /** `/{tenant}/{locale}/{adminPath}`, for the links to add a category or a publisher. */
  tenantBase: string;
  locale: 'ar' | 'en';
  form: ArticleForm;
  errors: Record<string, ArticleFieldProblem>;
  categories: readonly NewsCategoryView[];
  publishers: readonly NewsPublisherView[];
  disabled: boolean;
  onChange: (patch: (current: ArticleForm) => ArticleForm) => void;
}) {
  const t = useTranslations('news.articles.editor');
  const [tab, setTab] = useState<NewsLanguage>(form.defaultLanguage);

  const problemText = (key: string, limit?: number): string | undefined => {
    const problem = errors[key];
    if (!problem) return undefined;
    return problem === 'tooLong' ? t('problems.tooLong', { max: limit ?? 0 }) : t('problems.required');
  };

  const setText = (language: NewsLanguage, patch: Partial<ArticleTextDraft>): void =>
    onChange((current) => ({
      ...current,
      texts: { ...current.texts, [language]: { ...current.texts[language], ...patch } },
    }));

  const text = form.texts[tab];

  // A switched-off category or publisher stays offered while the article has it, so it can be saved as it is.
  const categoryOptions = categories.filter((category) => category.isActive || category.id === form.categoryId);
  const publisherOptions = publishers.filter((publisher) => publisher.isActive || publisher.id === form.publisherId);

  const languageOptions = NEWS_LANGUAGE.map((language) => ({
    value: language,
    label: language === form.defaultLanguage ? `${t(`languages.${language}`)} · ${t('defaultBadge')}` : t(`languages.${language}`),
  }));

  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="news-article-texts">
        <h2 id="news-article-texts" className="text-base font-semibold">
          {t('sectionTexts')}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor="news-default-language" label={t('writtenIn')} required>
            <Select
              value={form.defaultLanguage}
              disabled={disabled}
              onValueChange={(value) => onChange((current) => ({ ...current, defaultLanguage: value as NewsLanguage }))}
            >
              <SelectTrigger id="news-default-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NEWS_LANGUAGE.map((language) => (
                  <SelectItem key={language} value={language}>
                    {t(`languages.${language}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <p className="max-w-3xl text-sm text-muted-foreground">{t('textsNote')}</p>

        <SegmentedControl
          aria-label={t('sectionTexts')}
          value={tab}
          options={languageOptions}
          onChange={(value) => setTab(value as NewsLanguage)}
          fullWidth={false}
        />

        {/* One language at a time; the others stay in the form and are sent when written. */}
        <div className="space-y-4" dir={DIRECTION[tab]}>
          <Field
            htmlFor={`news-title-${tab}`}
            label={t('titleField')}
            required={tab === form.defaultLanguage}
            error={problemText(`title.${tab}`, LIMITS.title)}
          >
            <Input
              id={`news-title-${tab}`}
              value={text.title}
              maxLength={LIMITS.title}
              disabled={disabled}
              invalid={Boolean(errors[`title.${tab}`])}
              onChange={(event) => setText(tab, { title: event.target.value })}
            />
          </Field>
          <Counter value={text.title} max={LIMITS.title} label={t('counter', { count: text.title.length, max: LIMITS.title })} />

          <Field htmlFor={`news-summary-${tab}`} label={t('summaryField')} error={problemText(`summary.${tab}`, LIMITS.summary)}>
            <Textarea
              id={`news-summary-${tab}`}
              rows={3}
              value={text.summary}
              maxLength={LIMITS.summary}
              disabled={disabled}
              onChange={(event) => setText(tab, { summary: event.target.value })}
            />
          </Field>
          <Counter
            value={text.summary}
            max={LIMITS.summary}
            label={t('counter', { count: text.summary.length, max: LIMITS.summary })}
          />

          <Field
            htmlFor={`news-body-${tab}`}
            label={t('bodyField')}
            required={tab === form.defaultLanguage}
            error={problemText(`body.${tab}`, LIMITS.body)}
          >
            <Textarea
              id={`news-body-${tab}`}
              rows={14}
              value={text.body}
              maxLength={LIMITS.body}
              disabled={disabled}
              onChange={(event) => setText(tab, { body: event.target.value })}
            />
          </Field>
          <Counter value={text.body} max={LIMITS.body} label={t('counter', { count: text.body.length, max: LIMITS.body })} />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="news-article-details">
        <h2 id="news-article-details" className="text-base font-semibold">
          {t('sectionDetails')}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            htmlFor="news-category"
            label={t('category')}
            required
            error={errors.categoryId ? t('problems.categoryRequired') : undefined}
          >
            <Select
              value={form.categoryId}
              disabled={disabled}
              onValueChange={(value) => onChange((current) => ({ ...current, categoryId: value }))}
            >
              <SelectTrigger id="news-category">
                <SelectValue placeholder={t('choose')} />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {newsName(category.name, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            htmlFor="news-publisher"
            label={t('publisher')}
            required
            error={errors.publisherId ? t('problems.publisherRequired') : undefined}
          >
            <Select
              value={form.publisherId}
              disabled={disabled}
              onValueChange={(value) => onChange((current) => ({ ...current, publisherId: value }))}
            >
              <SelectTrigger id="news-publisher">
                <SelectValue placeholder={t('choose')} />
              </SelectTrigger>
              <SelectContent>
                {publisherOptions.map((publisher) => (
                  <SelectItem key={publisher.id} value={publisher.id}>
                    {newsName(publisher.name, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {categoryOptions.length === 0 || publisherOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {categoryOptions.length === 0 ? (
              <>
                {t('noCategories')}{' '}
                <Link className="font-medium text-primary underline-offset-4 hover:underline" href={`${tenantBase}/news/categories`}>
                  {t('addCategory')}
                </Link>{' '}
              </>
            ) : null}
            {publisherOptions.length === 0 ? (
              <>
                {t('noPublishers')}{' '}
                <Link className="font-medium text-primary underline-offset-4 hover:underline" href={`${tenantBase}/news/publishers`}>
                  {t('addPublisher')}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          {(['ar', 'en', 'fr'] as const).map((language) => (
            <Field
              key={language}
              htmlFor={`news-place-${language}`}
              label={t(`place${language === 'ar' ? 'Ar' : language === 'en' ? 'En' : 'Fr'}`)}
              error={problemText(`placeLabel.${language}`, NEWS_PLACE_LABEL_MAX)}
            >
              <Input
                id={`news-place-${language}`}
                dir={DIRECTION[language]}
                value={form.placeLabel[language]}
                maxLength={NEWS_PLACE_LABEL_MAX}
                disabled={disabled}
                onChange={(event) =>
                  onChange((current) => ({ ...current, placeLabel: { ...current.placeLabel, [language]: event.target.value } }))
                }
              />
            </Field>
          ))}
        </div>

        <label htmlFor="news-notify" className="flex w-fit cursor-pointer select-none items-center gap-2 text-sm font-medium">
          <Checkbox
            id="news-notify"
            checked={form.notifyResidents}
            disabled={disabled}
            onCheckedChange={(next) => onChange((current) => ({ ...current, notifyResidents: next === true }))}
          />
          {t('notifyResidents')}
        </label>
      </section>
    </div>
  );
}

/** How much of a limit is used. Said under the box in the text's own direction and in Latin digits. */
function Counter({ value, max, label }: { value: string; max: number; label: string }) {
  const near = value.length >= max * 0.9;
  return (
    <p className={near ? 'text-end text-xs text-warning' : 'text-end text-xs text-muted-foreground'} dir="ltr">
      {label}
    </p>
  );
}
