'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Newspaper } from 'lucide-react';
import {
  getLabels,
  saveNewsArticleSchema,
  type NewsArticleView,
  type NewsPlacementInput,
} from '@mechanization/shared-schemas';
import {
  archiveNewsArticle,
  cancelNewsArticleSchedule,
  createNewsArticle,
  deleteNewsArticle,
  getNewsArticle,
  logApiError,
  publishNewsArticle,
  setNewsArticlePlacement,
  updateNewsArticle,
} from '@/lib/api-client';
import {
  formatMunicipalDateTime,
  municipalDayTime,
  newsStatusVariant,
  useNewsCategories,
  useNewsPublishers,
} from '@/lib/news';
import {
  actionsFor,
  articleFormErrors,
  emptyArticleForm,
  formFingerprint,
  formFromView,
  toSaveInput,
  type ArticleAction,
  type ArticleForm,
} from '@/lib/news-article-form';
import { useLeaveGuard } from '@/lib/use-leave-guard';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ArticleFields } from './article-fields';
import { ArticleMedia } from './article-media';
import { ArticlePlacementDialog } from './article-placement-dialog';
import { ArticleScheduleDialog } from './article-schedule-dialog';

/** What waits for an answer before it is done: a confirmation, or a dialog of its own. */
type Pending = 'publish' | 'archive' | 'cancelSchedule' | 'delete' | 'schedule' | 'placement' | null;

/**
 * The News article editor: write an article, save it as a draft, and move it
 * through its statuses (publish, schedule, archive, pin and feature, delete) as
 * the signed-in user, on Day3ati.
 *
 * - **Day3ati is the authority.** The editor offers what the status allows
 *   (`actionsFor`) and shows Day3ati's refusal in words when it refuses anyway.
 * - **Publishing needs a saved article.** A button that moves an article is
 *   off while the form has changes, so what is published is what was written.
 * - **A save replaces the article.** The form holds all three languages and
 *   sends the ones written; a language emptied here is removed there.
 * - Leaving with unsaved changes asks first (`useLeaveGuard`).
 */
export function ArticleEditor({
  tenant,
  base,
  locale,
  token,
  initial,
}: {
  tenant: string;
  base: string;
  locale: 'ar' | 'en';
  token: string;
  /** The article being edited, or null for a new one. */
  initial: NewsArticleView | null;
}) {
  const t = useTranslations('news.articles.editor');
  const tList = useTranslations('news.articles');
  const labels = getLabels(locale);
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const categories = useNewsCategories(tenant, base, token, { locale, errorMessage: tList('loadError') });
  const publishers = useNewsPublishers(tenant, base, token, { locale, errorMessage: tList('loadError') });

  const [article, setArticle] = useState<NewsArticleView | null>(initial);
  const [form, setForm] = useState<ArticleForm>(() => (initial ? formFromView(initial) : emptyArticleForm(locale === 'en' ? 'en' : 'ar')));
  const [savedPrint, setSavedPrint] = useState(() => formFingerprint(initial ? formFromView(initial) : emptyArticleForm(locale === 'en' ? 'en' : 'ar')));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const inFlight = useRef(false);

  const dirty = formFingerprint(form) !== savedPrint;
  const errors = useMemo(() => (showErrors ? articleFormErrors(form) : {}), [form, showErrors]);
  const allowed = actionsFor(article?.status ?? null);
  const can = (action: ArticleAction): boolean => allowed.includes(action);
  const guard = useLeaveGuard(dirty && !busy);

  /** The article as Day3ati holds it now: the form follows it and the lists read it again. */
  const adopt = async (saved: NewsArticleView): Promise<void> => {
    setArticle(saved);
    const next = formFromView(saved);
    setForm(next);
    setSavedPrint(formFingerprint(next));
    queryClient.setQueryData(['news-article', tenant, saved.id], saved);
    await queryClient.invalidateQueries({ queryKey: ['news-articles', tenant] });
  };

  /**
   * The article's files, read again from Day3ati and put into the saved copy.
   * Only the files: the form is left as it is, so unsaved text is not lost. A
   * photo being prepared is followed this way until it is ready, and a failed
   * read is only logged (the next one tries again).
   */
  const refreshMedia = async (): Promise<void> => {
    if (!article) return;
    try {
      const fresh = await getNewsArticle(tenant, token, locale, article.id, undefined, { background: true });
      setArticle((current) => (current && current.id === fresh.id ? { ...current, media: fresh.media } : current));
    } catch (caught) {
      logApiError(caught);
    }
  };

  const explain = (caught: unknown): string => {
    logApiError(caught);
    return caught instanceof Error ? caught.message : t('saveFailed');
  };

  const save = async (): Promise<void> => {
    if (inFlight.current) return;
    setShowErrors(true);
    const found = articleFormErrors(form);
    const first = Object.keys(found)[0];
    if (first) {
      const [field, language] = first.split('.');
      const id = language ? `news-${field === 'placeLabel' ? 'place' : field}-${language}` : first === 'categoryId' ? 'news-category' : 'news-publisher';
      document.getElementById(id)?.focus();
      return;
    }

    const input = saveNewsArticleSchema.parse(toSaveInput(form));
    setFailure(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const saved = article
        ? await updateNewsArticle(tenant, token, locale, article.id, input)
        : await createNewsArticle(tenant, token, locale, input);
      await adopt(saved);
      toast.success(article ? t('saved') : t('created'));
      // A new draft has an address now; the editor continues there, with nothing unsaved to ask about.
      if (!article) router.replace(`${base}/news/articles/${saved.id}`);
    } catch (caught) {
      setFailure(explain(caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /** One move of the article through its statuses. Rejects with the localised refusal, for the dialog that asked. */
  const move = async (act: (id: string) => Promise<NewsArticleView>, success: (saved: NewsArticleView) => string): Promise<void> => {
    if (!article || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const saved = await act(article.id);
      await adopt(saved);
      setPending(null);
      toast.success(success(saved));
    } catch (caught) {
      throw new Error(explain(caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const publishNow = (): Promise<void> =>
    move(
      (id) => publishNewsArticle(tenant, token, locale, id, { publishAt: null }),
      () => t('toasts.published'),
    );

  const schedule = (publishAt: string): Promise<void> =>
    move(
      (id) => publishNewsArticle(tenant, token, locale, id, { publishAt }),
      (saved) => t('toasts.scheduled', { when: formatMunicipalDateTime(saved.publishAt ?? publishAt) }),
    );

  const archive = (): Promise<void> =>
    move(
      (id) => archiveNewsArticle(tenant, token, locale, id),
      () => t('toasts.archived'),
    );

  const cancelSchedule = (): Promise<void> =>
    move(
      (id) => cancelNewsArticleSchedule(tenant, token, locale, id),
      () => t('toasts.scheduleCancelled'),
    );

  const placement = (input: NewsPlacementInput): Promise<void> =>
    move(
      (id) => setNewsArticlePlacement(tenant, token, locale, id, input),
      () => t('toasts.placementSaved'),
    );

  const remove = async (): Promise<void> => {
    if (!article || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await deleteNewsArticle(tenant, token, locale, article.id);
      // Gone: nothing to save, and the list must not show it.
      setSavedPrint(formFingerprint(form));
      queryClient.removeQueries({ queryKey: ['news-article', tenant, article.id] });
      await queryClient.invalidateQueries({ queryKey: ['news-articles', tenant] });
      toast.success(t('toasts.deleted'));
      router.push(`${base}/news/articles`);
    } catch (caught) {
      throw new Error(explain(caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (categories.loading || publishers.loading) return <LoadingState label={t('sectionDetails')} />;
  if ((categories.error && !categories.data) || (publishers.error && !publishers.data)) {
    return (
      <ErrorState
        description={categories.error ?? publishers.error ?? tList('loadError')}
        onRetry={() => {
          void categories.refetch();
          void publishers.refetch();
        }}
      />
    );
  }

  const schedulingFrom = article?.publishAt ? municipalDayTime(article.publishAt) : null;
  const featuredFrom = article?.featuredUntil ? municipalDayTime(article.featuredUntil) : null;
  const movable = !dirty && !busy;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/news/articles`} label={t('back')} />

      <PageHeader icon={Newspaper} title={article ? t('editTitle') : t('newTitle')} />

      {article ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Badge variant={newsStatusVariant(article.status)}>{labels.newsArticleStatus[article.status]}</Badge>
          {article.status === 'scheduled' && article.publishAt ? (
            <span>{t('state.scheduledFor', { when: formatMunicipalDateTime(article.publishAt) })}</span>
          ) : null}
          {article.status === 'published' && article.publishedAt ? (
            <span>{t('state.publishedOn', { when: formatMunicipalDateTime(article.publishedAt) })}</span>
          ) : null}
          {article.isPinned ? <span>{t('state.pinned')}</span> : null}
          {article.featuredUntil ? (
            <span>{t('state.featuredUntil', { when: formatMunicipalDateTime(article.featuredUntil) })}</span>
          ) : null}
        </div>
      ) : null}

      {failure ? (
        <Alert variant="destructive" live="alert">
          {failure}
        </Alert>
      ) : null}

      <ArticleFields
        tenantBase={base}
        locale={locale}
        form={form}
        errors={errors}
        categories={categories.data ?? []}
        publishers={publishers.data ?? []}
        disabled={busy}
        onChange={(patch) => setForm(patch)}
      />

      <div className="border-t pt-6">
        {article ? (
          <ArticleMedia
            tenant={tenant}
            token={token}
            locale={locale}
            articleId={article.id}
            media={article.media}
            onChanged={refreshMedia}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('media.saveFirst')}</p>
        )}
      </div>

      <div className="space-y-3 border-t pt-6">
        {article && dirty && allowed.some((action) => action !== 'save' && action !== 'delete') ? (
          <p className="text-sm text-muted-foreground">{t('saveFirst')}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={busy || (Boolean(article) && !dirty)}>
            {busy ? t('saving') : t('save')}
          </Button>

          {can('publishNow') ? (
            <Button variant="outline" disabled={!movable} onClick={() => setPending('publish')}>
              {t('actions.publishNow')}
            </Button>
          ) : null}
          {can('publishAgain') ? (
            <Button variant="outline" disabled={!movable} onClick={() => setPending('publish')}>
              {t('actions.publishAgain')}
            </Button>
          ) : null}
          {can('schedule') ? (
            <Button variant="outline" disabled={!movable} onClick={() => setPending('schedule')}>
              {article?.status === 'scheduled' ? t('actions.reschedule') : t('actions.schedule')}
            </Button>
          ) : null}
          {can('cancelSchedule') ? (
            <Button variant="outline" disabled={!movable} onClick={() => setPending('cancelSchedule')}>
              {t('actions.cancelSchedule')}
            </Button>
          ) : null}
          {can('archive') ? (
            <Button variant="outline" disabled={!movable} onClick={() => setPending('archive')}>
              {t('actions.archive')}
            </Button>
          ) : null}
          {can('placement') ? (
            <Button variant="outline" disabled={!movable} onClick={() => setPending('placement')}>
              {t('actions.placement')}
            </Button>
          ) : null}
          {can('delete') ? (
            <Button variant="destructive" disabled={busy} onClick={() => setPending('delete')} className="ms-auto">
              {t('actions.delete')}
            </Button>
          ) : null}
        </div>
      </div>

      {pending === 'schedule' ? (
        <ArticleScheduleDialog locale={locale} initial={schedulingFrom} onSchedule={schedule} onClose={() => setPending(null)} />
      ) : null}
      {pending === 'placement' && article ? (
        <ArticlePlacementDialog
          locale={locale}
          current={{ isPinned: article.isPinned, featuredUntil: featuredFrom }}
          onSave={placement}
          onClose={() => setPending(null)}
        />
      ) : null}

      <ConfirmDialog
        open={pending === 'publish'}
        onOpenChange={(open) => !open && setPending(null)}
        destructive={false}
        title={t('confirm.publishTitle')}
        description={
          form.notifyResidents ? `${t('confirm.publishBody')} ${t('confirm.publishNotify')}` : t('confirm.publishBody')
        }
        confirmLabel={article?.status === 'archived' ? t('actions.publishAgain') : t('actions.publishNow')}
        cancelLabel={t('cancel')}
        onConfirm={publishNow}
      />
      <ConfirmDialog
        open={pending === 'archive'}
        onOpenChange={(open) => !open && setPending(null)}
        destructive={false}
        title={t('confirm.archiveTitle')}
        description={t('confirm.archiveBody')}
        confirmLabel={t('actions.archive')}
        cancelLabel={t('cancel')}
        onConfirm={archive}
      />
      <ConfirmDialog
        open={pending === 'cancelSchedule'}
        onOpenChange={(open) => !open && setPending(null)}
        destructive={false}
        title={t('confirm.cancelScheduleTitle')}
        description={t('confirm.cancelScheduleBody')}
        confirmLabel={t('actions.cancelSchedule')}
        cancelLabel={t('cancel')}
        onConfirm={cancelSchedule}
      />
      <ConfirmDialog
        open={pending === 'delete'}
        onOpenChange={(open) => !open && setPending(null)}
        title={t('confirm.deleteTitle')}
        description={t('confirm.deleteBody')}
        confirmLabel={t('actions.delete')}
        cancelLabel={t('cancel')}
        onConfirm={remove}
      />
      <ConfirmDialog
        open={guard.pendingHref !== null}
        onOpenChange={(open) => !open && guard.stay()}
        title={t('unsavedTitle')}
        description={t('unsavedBody')}
        confirmLabel={t('leave')}
        cancelLabel={t('stay')}
        destructive={false}
        onConfirm={guard.leave}
      />
    </div>
  );
}
