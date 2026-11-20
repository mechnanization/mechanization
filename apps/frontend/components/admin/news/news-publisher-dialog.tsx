'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  NEWS_NAME_MAX,
  NEWS_PUBLISHER_KIND,
  createNewsPublisherSchema,
  getLabels,
  updateNewsPublisherSchema,
  type NewsPublisherKind,
  type NewsPublisherView,
} from '@mechanization/shared-schemas';
import { createNewsPublisher, logApiError, updateNewsPublisher } from '@/lib/api-client';
import { newsFieldErrors, type NewsFieldWording } from '@/lib/news';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const NAME_AR_ID = 'news-publisher-name-ar';

/**
 * Adds a News publisher, or edits one, on Day3ati: who an article is published
 * as. Names in three languages (Arabic required) and the kind. An edit sends
 * every field, because Day3ati replaces the whole record.
 */
export function NewsPublisherDialog({
  tenant,
  token,
  locale,
  editing,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** The publisher being edited, or null to add one. */
  editing: NewsPublisherView | null;
  onClose: () => void;
}) {
  const t = useTranslations('news.publishers');
  const tf = useTranslations('news.fieldErrors');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const [nameAr, setNameAr] = useState(editing?.name.ar ?? '');
  const [nameEn, setNameEn] = useState(editing?.name.en ?? '');
  const [nameFr, setNameFr] = useState(editing?.name.fr ?? '');
  const [kind, setKind] = useState<NewsPublisherKind>(editing?.kind ?? 'municipality');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const wording: NewsFieldWording = {
    'news.invalid_category_key': tf('invalidCategoryKey'),
    'news.category_key_taken': tf('categoryKeyTaken'),
    'news.name_required': tf('nameRequired'),
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const body = { nameAr, nameEn, nameFr, kind };
    const parsed = editing
      ? updateNewsPublisherSchema.safeParse({ ...body, isActive: editing.isActive })
      : createNewsPublisherSchema.safeParse(body);

    if (!parsed.success) {
      setErrors({ nameAr: t('nameRequired') });
      document.getElementById(NAME_AR_ID)?.focus();
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) await updateNewsPublisher(tenant, token, locale, editing.id, parsed.data as never);
      else await createNewsPublisher(tenant, token, locale, parsed.data as never);
      await queryClient.invalidateQueries({ queryKey: ['news-publishers', tenant] });
      onClose();
    } catch (caught) {
      logApiError(caught);
      const fields = newsFieldErrors(caught, wording);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
        if (fields.nameAr) document.getElementById(NAME_AR_ID)?.focus();
      } else {
        // Already the localised text for the code (TXT-6): «not allowed», «not available», …
        setFormError(caught instanceof Error ? caught.message : t('saveFailed'));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{editing ? t('editTitle') : t('addTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <Field htmlFor={NAME_AR_ID} label={t('nameAr')} error={errors.nameAr || undefined} required>
            <Input
              id={NAME_AR_ID}
              value={nameAr}
              maxLength={NEWS_NAME_MAX}
              placeholder={t('nameArPlaceholder')}
              invalid={Boolean(errors.nameAr)}
              onChange={(event) => {
                setNameAr(event.target.value);
                setErrors((current) => ({ ...current, nameAr: '' }));
              }}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="news-publisher-name-en" label={t('nameEn')} error={errors.nameEn || undefined}>
              <Input
                id="news-publisher-name-en"
                dir="ltr"
                value={nameEn}
                maxLength={NEWS_NAME_MAX}
                onChange={(event) => setNameEn(event.target.value)}
              />
            </Field>
            <Field htmlFor="news-publisher-name-fr" label={t('nameFr')} error={errors.nameFr || undefined}>
              <Input
                id="news-publisher-name-fr"
                dir="ltr"
                value={nameFr}
                maxLength={NEWS_NAME_MAX}
                onChange={(event) => setNameFr(event.target.value)}
              />
            </Field>
          </div>
          <Field htmlFor="news-publisher-kind" label={t('kind')} error={errors.kind || undefined} required>
            <Select value={kind} onValueChange={(value) => setKind(value as NewsPublisherKind)}>
              <SelectTrigger id="news-publisher-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NEWS_PUBLISHER_KIND.map((value) => (
                  <SelectItem key={value} value={value}>
                    {labels.newsPublisherKind[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">
              {busy ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
