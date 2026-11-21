'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, ImageIcon } from 'lucide-react';
import {
  NEWS_CAPTION_MAX,
  NEWS_MEDIA_ACCEPT,
  NEWS_MEDIA_MAX_PER_ARTICLE,
  newsFileProblem,
  type NewsMediaView,
} from '@mechanization/shared-schemas';
import { deleteNewsMedia, logApiError, setNewsMediaCover, uploadNewsMedia } from '@/lib/api-client';
import { newsFieldErrors, newsName, useNewsFieldWording } from '@/lib/news';
import {
  anyProcessing,
  formatFileSize,
  inDisplayOrder,
  mayAddFile,
  openableUrl,
  thumbnailSrc,
} from '@/lib/news-media';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

/** How often the article is read again while a photo is being prepared. */
const POLL_MS = 3_000;

const STATUS_VARIANT = { processing: 'soft-info', ready: 'soft-success', failed: 'soft-destructive' } as const;

const isPdfFile = (file: File): boolean => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

/**
 * The photos and PDFs of a saved News article: what it has, and how to add,
 * choose the cover of, replace and remove them. They live on Day3ati.
 *
 * - **Upload with progress.** A file goes by `uploadNewsMedia` (an
 *   `XMLHttpRequest`, the only way to say how far a ten-megabyte photo has got).
 *   Files are sent one after another. A file the browser can already tell is the
 *   wrong kind or too large is not sent; the server reads the bytes and decides
 *   again, and Day3ati has the last word, all of them under the same box.
 * - **A photo is prepared in the background.** It is `processing` for a moment;
 *   while any is, the article is read again every few seconds (`onChanged`)
 *   until each is `ready` or `failed`.
 * - **A failed photo is uploaded again**, with the id it replaces, rather than
 *   deleted and added: «رفع من جديد».
 * - A thumbnail is drawn only from the media host the page's policy lets images
 *   in from (`thumbnailSrc`); otherwise an icon stands in.
 */
export function ArticleMedia({
  tenant,
  token,
  locale,
  articleId,
  media,
  onChanged,
}: {
  tenant: string;
  token: string;
  locale: string;
  articleId: string;
  media: readonly NewsMediaView[];
  /** Reads the article's files again. Must not throw. */
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations('news.articles.editor.media');
  const toast = useToast();
  const wording = useNewsFieldWording();

  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<NewsMediaView | null>(null);
  const [asCover, setAsCover] = useState(false);
  const [captions, setCaptions] = useState({ ar: '', en: '', fr: '' });
  const [deleting, setDeleting] = useState<NewsMediaView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const ordered = inDisplayOrder(media);
  const processing = anyProcessing(media);
  const mayAdd = mayAddFile(media) || replacing !== null;

  // Read again while a photo is being prepared. The latest `onChanged` is called, so the timer is not
  // restarted by every render of the editor.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void changed.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [processing]);

  const send = async (files: File[]): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    const refused: string[] = [];
    try {
      // A replacement is one file; otherwise as many as the dialog gave, one after another.
      for (const file of replacing ? files.slice(0, 1) : files) {
        const problem = newsFileProblem(file);
        if (problem) {
          refused.push(t(`problems.${problem}`, { name: file.name }));
          continue;
        }

        const form = new FormData();
        form.set('file', file);
        form.set('isCover', asCover && !isPdfFile(file) ? 'true' : 'false');
        if (captions.ar.trim()) form.set('captionAr', captions.ar.trim());
        if (captions.en.trim()) form.set('captionEn', captions.en.trim());
        if (captions.fr.trim()) form.set('captionFr', captions.fr.trim());
        if (replacing) form.set('replacesMediaId', replacing.id);

        setUploading({ name: file.name, percent: 0 });
        try {
          await uploadNewsMedia(tenant, token, locale, articleId, form, {
            onProgress: (fraction) => setUploading({ name: file.name, percent: Math.round(fraction * 100) }),
          });
          toast.success(t('uploaded'));
          setReplacing(null);
          setAsCover(false);
          setCaptions({ ar: '', en: '', fr: '' });
          await onChanged();
        } catch (caught) {
          logApiError(caught);
          // The refusal under the file box: ours and Day3ati's read the same.
          setFailure(newsFieldErrors(caught, wording).file ?? (caught instanceof Error ? caught.message : t('actionFailed')));
          break;
        }
      }
    } finally {
      setUploading(null);
      setProblems(refused);
      inFlight.current = false;
    }
  };

  const makeCover = async (item: NewsMediaView): Promise<void> => {
    if (busyId) return;
    setBusyId(item.id);
    setFailure(null);
    try {
      await setNewsMediaCover(tenant, token, locale, articleId, item.id);
      toast.success(t('coverSet'));
      await onChanged();
    } catch (caught) {
      logApiError(caught);
      setFailure(caught instanceof Error ? caught.message : t('actionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    try {
      await deleteNewsMedia(tenant, token, locale, articleId, deleting.id);
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof Error ? caught.message : t('actionFailed'));
    }
    toast.success(t('deleted'));
    setDeleting(null);
    await onChanged();
  };

  return (
    <section className="space-y-4" aria-labelledby="news-article-media">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="news-article-media" className="text-base font-semibold">
          {t('title')}
        </h2>
        <span className="text-sm text-muted-foreground tabular-nums">
          {t('count', { count: media.length, max: NEWS_MEDIA_MAX_PER_ARTICLE })}
        </span>
      </div>

      {failure ? (
        <Alert variant="destructive" live="alert">
          {failure}
        </Alert>
      ) : null}

      {processing ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span role="status">{t('processingNote')}</span>
          <Button variant="ghost" size="sm" className="!w-auto" onClick={() => void onChanged()}>
            {t('checkAgain')}
          </Button>
        </div>
      ) : null}

      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {ordered.map((item) => {
            const thumb = thumbnailSrc(item.thumbnailUrl);
            const link = item.status === 'ready' ? openableUrl(item.url) : null;
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Day3ati's own host, not a Next-optimised image
                    <img src={thumb} alt="" className="size-16 object-cover" loading="lazy" />
                  ) : item.kind === 'pdf' ? (
                    <FileText className="size-6" aria-hidden />
                  ) : (
                    <ImageIcon className="size-6" aria-hidden />
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.kind === 'pdf' ? t('pdf') : t('photo')}</span>
                    <Badge variant={STATUS_VARIANT[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                    {item.isCover ? <Badge variant="soft-default">{t('cover')}</Badge> : null}
                    <span className="text-xs text-muted-foreground tabular-nums" dir="ltr">
                      {formatFileSize(item.sizeBytes)}
                    </span>
                  </div>
                  {item.caption ? <p className="text-sm text-muted-foreground">{newsName(item.caption, locale)}</p> : null}
                  {item.status === 'failed' ? <p className="text-sm text-destructive">{t('failedHelp')}</p> : null}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  {link ? (
                    <Button asChild variant="ghost" size="sm" className="!w-auto">
                      <a href={link} target="_blank" rel="noopener noreferrer">
                        {t('open')}
                      </a>
                    </Button>
                  ) : null}
                  {item.kind === 'image' && item.status === 'ready' && !item.isCover ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!w-auto"
                      disabled={busyId !== null}
                      onClick={() => void makeCover(item)}
                    >
                      {t('makeCover')}
                    </Button>
                  ) : null}
                  {item.status === 'failed' ? (
                    <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setReplacing(item)}>
                      {t('uploadAgain')}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setDeleting(item)}>
                    {t('delete')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {replacing ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>{t('replacing')}</span>
          <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setReplacing(null)}>
            {t('cancelReplace')}
          </Button>
        </div>
      ) : null}

      {mayAdd ? (
        <div className="space-y-4">
          <FileInput
            id="news-media-file"
            accept={NEWS_MEDIA_ACCEPT}
            multiple={replacing === null}
            disabled={uploading !== null}
            label={t('dropLabel')}
            hint={t('hint')}
            invalid={Boolean(failure)}
            onSelect={(files) => void send(files)}
          />

          {uploading ? (
            <div className="space-y-1" role="status">
              <p className="text-sm tabular-nums" dir="auto">
                {t('uploading', { name: uploading.name, percent: uploading.percent })}
              </p>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploading.percent}
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${uploading.percent}%` }} />
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            {(['ar', 'en', 'fr'] as const).map((language) => (
              <Field
                key={language}
                htmlFor={`news-media-caption-${language}`}
                label={t(`caption${language === 'ar' ? 'Ar' : language === 'en' ? 'En' : 'Fr'}`)}
              >
                <Input
                  id={`news-media-caption-${language}`}
                  dir={language === 'ar' ? 'rtl' : 'ltr'}
                  value={captions[language]}
                  maxLength={NEWS_CAPTION_MAX}
                  disabled={uploading !== null}
                  onChange={(event) => setCaptions((current) => ({ ...current, [language]: event.target.value }))}
                />
              </Field>
            ))}
          </div>

          <label
            htmlFor="news-media-cover"
            className="flex w-fit cursor-pointer select-none items-center gap-2 text-sm font-medium"
          >
            <Checkbox
              id="news-media-cover"
              checked={asCover}
              disabled={uploading !== null}
              onCheckedChange={(next) => setAsCover(next === true)}
            />
            {t('useAsCover')}
          </label>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('limitReached')}</p>
      )}

      {problems.length > 0 ? (
        <Alert variant="destructive" live="alert">
          <ul className="space-y-1">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('deleteTitle')}
        description={t('deleteBody')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={remove}
      />
    </section>
  );
}
