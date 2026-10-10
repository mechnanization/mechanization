'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { createIncomeCategorySchema, updateIncomeCategorySchema } from '@mechanization/shared-schemas';
import {
  createIncomeCategory,
  logApiError,
  updateIncomeCategory,
  type IncomeCategoryView,
} from '@/lib/api-client';
import { withSavedCategory } from '@/lib/category-cache';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * «بند إيراد جديد» / «تعديل البند» — the fields a municipality owns on an income
 * category: its Arabic name, its English one if it has one, and its place in
 * the municipality's budget.
 *
 * One editor for both places a category is written: the «بنود الإيرادات» page,
 * and inline in the recording form, where the manager adds the missing source
 * without losing the half-filled voucher. It draws no frame of its own — each
 * caller frames it once (BAN-4).
 *
 * Writing is the manager's alone (docs/finance.md §4.3); callers only render it
 * for `TREASURY_ADMIN_ROLES`, and `IncomeController` enforces the same.
 *
 * Stopping and restarting a category is not here: it is one press on the list,
 * not a form. An edit sends no `active`, so it never changes one.
 */
export function IncomeCategoryEditor({
  tenant,
  token,
  category,
  existing,
  onSaved,
  onCancel,
}: {
  tenant: string;
  token: string;
  /** The category being edited; absent to add a new one. */
  category?: IncomeCategoryView;
  /** Every category, for the same-name warning. */
  existing: IncomeCategoryView[];
  onSaved: (category: IncomeCategoryView) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.income.categoryEditor');
  const queryClient = useQueryClient();
  const id = useId();
  const [labelAr, setLabelAr] = useState(category?.labelAr ?? '');
  const [labelEn, setLabelEn] = useState(category?.labelEn ?? '');
  const [chapterCode, setChapterCode] = useState(category?.chapterCode ?? '');
  const [itemCode, setItemCode] = useState(category?.itemCode ?? '');
  const [errors, setErrors] = useState<{ labelAr?: string; codes?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /*
    A warning, not a block: nothing in the database stops two categories
    sharing a name, and refusing here would claim a guarantee the schema does
    not make. Two on the same budget article are refused, by a unique index.
  */
  const duplicate =
    labelAr.trim().length > 0 &&
    existing.some(
      (other) =>
        other.id !== category?.id &&
        other.labelAr.trim().localeCompare(labelAr.trim(), undefined, { sensitivity: 'base' }) === 0,
    );

  const save = async (): Promise<void> => {
    if (inFlight.current) return;
    const body = {
      labelAr,
      labelEn: labelEn.trim() || undefined,
      chapterCode: chapterCode.trim() || undefined,
      itemCode: itemCode.trim() || undefined,
    };
    const parsed = (category ? updateIncomeCategorySchema : createIncomeCategorySchema).safeParse(body);
    if (!parsed.success) {
      // The schema's messages are Arabic by design; the words come from this screen's messages (TXT-1).
      const field = String(parsed.error.issues[0]?.path[0] ?? 'labelAr');
      setErrors(field === 'labelAr' ? { labelAr: t('errors.labelAr') } : field === 'labelEn' ? { form: t('errors.labelEn') } : { codes: t('errors.codes') });
      document.getElementById(`${id}-${field === 'labelAr' ? 'ar' : field === 'labelEn' ? 'en' : 'chapter'}`)?.focus();
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setErrors({});
    try {
      const saved = category
        ? await updateIncomeCategory(tenant, token, { id: category.id, ...parsed.data })
        : await createIncomeCategory(tenant, token, parsed.data);
      /*
        Both category lists are reference reads — the form's (active only) and
        the register's and «بنود الإيرادات»'s (`'all'`) — fetched once and never
        re-read by themselves, so a category added inline would be missing from
        the register's filter and the next form until a reload. Written into the
        cache rather than invalidated, as the expense form's `NewCategoryFields`
        does: a refetch rebuilds the options under the form's open select, and
        Radix answers that with an empty selection.
      */
      queryClient.setQueryData<IncomeCategoryView[]>(['treasury', tenant, 'income-categories'], (current) =>
        withSavedCategory(current, saved, false),
      );
      queryClient.setQueryData<IncomeCategoryView[]>(['treasury', tenant, 'income-categories', 'all'], (current) =>
        withSavedCategory(current, saved, true),
      );
      onSaved(saved);
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6) — a taken budget article among them.
      setErrors({ form: caught instanceof Error ? caught.message : t('errors.form') });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor={`${id}-ar`} label={t('labelAr')} error={errors.labelAr} required>
          <Input
            id={`${id}-ar`}
            value={labelAr}
            maxLength={120}
            placeholder={t('labelArPlaceholder')}
            invalid={Boolean(errors.labelAr)}
            onChange={(event) => {
              setLabelAr(event.target.value);
              setErrors((current) => ({ ...current, labelAr: undefined }));
            }}
          />
        </Field>
        <Field htmlFor={`${id}-en`} label={t('labelEn')} optionalLabel={t('optional')}>
          {/* An English name reads left to right whatever the page (RTL-2). */}
          <Input
            id={`${id}-en`}
            dir="ltr"
            value={labelEn}
            maxLength={120}
            placeholder={t('labelEnPlaceholder')}
            onChange={(event) => setLabelEn(event.target.value)}
          />
        </Field>
      </div>

      {duplicate ? (
        <Alert variant="warning" live="status">
          {t('duplicate')}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor={`${id}-chapter`} label={t('chapterCode')} error={errors.codes} optionalLabel={t('optional')}>
          <Input
            id={`${id}-chapter`}
            dir="ltr"
            inputMode="decimal"
            value={chapterCode}
            placeholder={t('codePlaceholder')}
            invalid={Boolean(errors.codes)}
            onChange={(event) => {
              setChapterCode(event.target.value);
              setErrors((current) => ({ ...current, codes: undefined }));
            }}
          />
        </Field>
        <Field htmlFor={`${id}-item`} label={t('itemCode')} optionalLabel={t('optional')}>
          <Input
            id={`${id}-item`}
            dir="ltr"
            inputMode="decimal"
            value={itemCode}
            placeholder={t('codePlaceholder')}
            invalid={Boolean(errors.codes)}
            onChange={(event) => {
              setItemCode(event.target.value);
              setErrors((current) => ({ ...current, codes: undefined }));
            }}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('codesHint')}</p>

      {errors.form ? (
        <Alert variant="destructive" live="alert">
          {errors.form}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={save} disabled={busy}>
          {busy ? t('saving') : category ? t('saveEdit') : t('create')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
