'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  NEWS_CATEGORY_KEY_MAX,
  NEWS_ICON_MAX,
  NEWS_NAME_MAX,
  createNewsCategorySchema,
  updateNewsCategorySchema,
  type NewsCategoryView,
} from '@mechanization/shared-schemas';
import { createNewsCategory, logApiError, updateNewsCategory } from '@/lib/api-client';
import { newsFieldErrors, type NewsFieldWording } from '@/lib/news';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/** The inputs' ids, so a refused field can be focused. */
const IDS = {
  key: 'news-category-key',
  nameAr: 'news-category-name-ar',
  sortOrder: 'news-category-order',
} as const;

/**
 * Adds a News category, or edits one, on Day3ati.
 *
 * The key is chosen once and then shown, locked: Day3ati ignores a changed key,
 * and a field that looked editable would lie. Names go in three languages, the
 * Arabic one required. What the form can check (an empty name, a key that is
 * not lowercase words) is refused here in the page's words; what only Day3ati
 * knows (a key already taken) comes back by code and is shown under the same
 * field. An edit sends every field, because Day3ati replaces the whole record.
 */
export function NewsCategoryDialog({
  tenant,
  token,
  locale,
  editing,
  suggestedOrder,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** The category being edited, or null to add one. */
  editing: NewsCategoryView | null;
  /** The display order a new category starts with: after the last one. */
  suggestedOrder: number;
  onClose: () => void;
}) {
  const t = useTranslations('news.categories');
  const tf = useTranslations('news.fieldErrors');
  const queryClient = useQueryClient();
  const [key, setKey] = useState(editing?.key ?? '');
  const [nameAr, setNameAr] = useState(editing?.name.ar ?? '');
  const [nameEn, setNameEn] = useState(editing?.name.en ?? '');
  const [nameFr, setNameFr] = useState(editing?.name.fr ?? '');
  const [icon, setIcon] = useState(editing?.icon ?? '');
  const [sortOrder, setSortOrder] = useState(String(editing?.sortOrder ?? suggestedOrder));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const wording: NewsFieldWording = {
    'news.invalid_category_key': tf('invalidCategoryKey'),
    'news.category_key_taken': tf('categoryKeyTaken'),
    'news.name_required': tf('nameRequired'),
  };

  const clear = (field: string): void => setErrors((current) => ({ ...current, [field]: '' }));

  const focusFirst = (found: Record<string, string>): void => {
    const first = (['key', 'nameAr', 'sortOrder'] as const).find((field) => found[field]);
    if (first) document.getElementById(IDS[first])?.focus();
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;

    const order = sortOrder.trim() === '' ? NaN : Number(sortOrder);
    const body = { nameAr, nameEn, nameFr, icon, sortOrder: order };
    const parsed = editing
      ? updateNewsCategorySchema.safeParse({ ...body, isActive: editing.isActive })
      : createNewsCategorySchema.safeParse({ ...body, key });

    if (!parsed.success) {
      // The page's own words for what the form can check; the schema's text is not shown.
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (field in found) continue;
        if (field === 'nameAr') found[field] = t('nameRequired');
        else if (field === 'key') found[field] = key.trim() === '' ? t('keyRequired') : t('keyInvalid');
        else if (field === 'sortOrder') found[field] = t('sortOrderInvalid');
        else if (field === 'nameEn' || field === 'nameFr' || field === 'icon') found[field] = t('saveFailed');
      }
      setErrors(found);
      focusFirst(found);
      return;
    }

    setErrors({});
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) await updateNewsCategory(tenant, token, locale, editing.id, parsed.data as never);
      else await createNewsCategory(tenant, token, locale, parsed.data as never);
      await queryClient.invalidateQueries({ queryKey: ['news-categories', tenant] });
      onClose();
    } catch (caught) {
      logApiError(caught);
      const fields = newsFieldErrors(caught, wording);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
        focusFirst(fields);
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
          <Field htmlFor={IDS.key} label={t('key')} error={errors.key || undefined} required>
            <Input
              id={IDS.key}
              dir="ltr"
              value={key}
              maxLength={NEWS_CATEGORY_KEY_MAX}
              placeholder={t('keyPlaceholder')}
              disabled={Boolean(editing)}
              invalid={Boolean(errors.key)}
              onChange={(event) => {
                setKey(event.target.value);
                clear('key');
              }}
            />
          </Field>
          {editing ? null : <p className="text-xs text-muted-foreground">{t('keyHint')}</p>}
          <Field htmlFor={IDS.nameAr} label={t('nameAr')} error={errors.nameAr || undefined} required>
            <Input
              id={IDS.nameAr}
              value={nameAr}
              maxLength={NEWS_NAME_MAX}
              placeholder={t('nameArPlaceholder')}
              invalid={Boolean(errors.nameAr)}
              onChange={(event) => {
                setNameAr(event.target.value);
                clear('nameAr');
              }}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="news-category-name-en" label={t('nameEn')} error={errors.nameEn || undefined}>
              <Input
                id="news-category-name-en"
                dir="ltr"
                value={nameEn}
                maxLength={NEWS_NAME_MAX}
                onChange={(event) => setNameEn(event.target.value)}
              />
            </Field>
            <Field htmlFor="news-category-name-fr" label={t('nameFr')} error={errors.nameFr || undefined}>
              <Input
                id="news-category-name-fr"
                dir="ltr"
                value={nameFr}
                maxLength={NEWS_NAME_MAX}
                onChange={(event) => setNameFr(event.target.value)}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="news-category-icon" label={t('icon')} error={errors.icon || undefined}>
              <Input
                id="news-category-icon"
                dir="ltr"
                value={icon}
                maxLength={NEWS_ICON_MAX}
                onChange={(event) => setIcon(event.target.value)}
              />
            </Field>
            <Field htmlFor={IDS.sortOrder} label={t('sortOrder')} error={errors.sortOrder || undefined}>
              <Input
                id={IDS.sortOrder}
                inputMode="numeric"
                dir="ltr"
                value={sortOrder}
                invalid={Boolean(errors.sortOrder)}
                onChange={(event) => {
                  setSortOrder(event.target.value.replace(/[^\d-]/g, ''));
                  clear('sortOrder');
                }}
              />
            </Field>
          </div>

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
