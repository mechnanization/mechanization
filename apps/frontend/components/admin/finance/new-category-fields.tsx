'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { createExpenseCategorySchema } from '@mechanization/shared-schemas';
import { createExpenseCategory, logApiError, type ExpenseCategoryView } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * «بند صرف جديد», without leaving the half-filled voucher.
 *
 * Inline rather than a dialog over the form: a modal here would cover the very
 * fields the officer is deciding the band from, and losing what they typed is
 * the one failure this exists to avoid.
 */
export function NewCategoryFields({
  tenant,
  token,
  existing,
  onCreated,
  onCancel,
}: {
  tenant: string;
  token: string;
  existing: ExpenseCategoryView[];
  onCreated: (category: ExpenseCategoryView) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.newCategory');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [chapterCode, setChapterCode] = useState('');
  const [itemCode, setItemCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /*
    A warning, not a block: nothing in the database stops two bands sharing a
    name, and refusing here would claim a guarantee the schema does not make.
    Duplicate *budget codes* are refused, by a partial unique index.
  */
  const duplicate =
    name.trim().length > 0 &&
    existing.some(
      (category) => category.name.trim().localeCompare(name.trim(), undefined, { sensitivity: 'base' }) === 0,
    );

  const create = async (): Promise<void> => {
    if (inFlight.current) return;
    const parsed = createExpenseCategorySchema.safeParse({
      name,
      chapterCode: chapterCode.trim() || undefined,
      itemCode: itemCode.trim() || undefined,
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'name');
      setError(field === 'name' ? t('errors.name') : t('errors.codes'));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await createExpenseCategory(tenant, token, parsed.data);
      /*
        The band list is a reference read (`useStaffQuery`'s `reference`): fetched
        once and never re-read by itself, so without this the register's filter
        and the next form would go on without the band until a reload. Written
        into the cache rather than invalidated, because an invalidation refetches
        the list under the form's open select, and Radix answers a rebuilt
        option list with an empty selection. Appended, the list the select is
        drawn from keeps its order.
      */
      queryClient.setQueryData<ExpenseCategoryView[]>(['treasury', tenant, 'expense-categories'], (current) =>
        current ? [...current.filter((category) => category.id !== created.id), created] : current,
      );
      onCreated(created);
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof Error ? caught.message : t('errors.form'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3"
      onKeyDown={(event) => {
        /*
          These inputs sit inside the voucher's `<form>`, so Enter in one of them
          would submit the voucher — and submitting is paying. Enter here means
          «أنشئ البند».
        */
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          void create();
        }
      }}
    >
      <p className="text-xs font-medium text-muted-foreground">{t('title')}</p>

      <Field htmlFor="new-category-name" label={t('name')} error={error ?? undefined} required>
        <Input
          id="new-category-name"
          value={name}
          placeholder={t('namePlaceholder')}
          invalid={Boolean(error)}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </Field>

      {duplicate ? (
        <Alert variant="warning" live="status">
          {t('duplicate')}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="new-category-chapter" label={t('chapterCode')} optionalLabel={t('optional')}>
          <Input
            id="new-category-chapter"
            dir="ltr"
            inputMode="numeric"
            value={chapterCode}
            placeholder={t('codePlaceholder')}
            onChange={(event) => setChapterCode(event.target.value)}
          />
        </Field>
        <Field htmlFor="new-category-item" label={t('itemCode')} optionalLabel={t('optional')}>
          <Input
            id="new-category-item"
            dir="ltr"
            inputMode="numeric"
            value={itemCode}
            placeholder={t('codePlaceholder')}
            onChange={(event) => setItemCode(event.target.value)}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('codesHint')}</p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={create} disabled={busy}>
          {busy ? t('saving') : t('create')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {/* Drawn for LTR; flipped in Arabic (RTL-3). */}
          <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
