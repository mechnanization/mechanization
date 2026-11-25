'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { NewCategoryFields } from '../new-category-fields';
import type { RecordExpenseState } from './use-record-expense';

/**
 * What the voucher was for and what stands behind it: the band (and the
 * manager's new one), the payee, the day, the invoice and the receipt, why it is
 * back-dated, and the reason. Cells of the form's grid.
 */
export function VoucherFields({
  form,
  tenant,
  token,
  locale,
}: {
  form: RecordExpenseState;
  tenant: string;
  token: string;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const {
    today,
    pays,
    errors,
    categoryId,
    setCategoryId,
    added,
    setAdded,
    addingCategory,
    setAddingCategory,
    canManageCategories,
    allCategories,
    payee,
    setPayee,
    paidOn,
    setPaidOn,
    invoiceNumber,
    setInvoiceNumber,
    hasPhysicalReceipt,
    setHasPhysicalReceipt,
    backdated,
    adjustmentReason,
    setAdjustmentReason,
    description,
    setDescription,
    done,
  } = form;

  return (
    <>
      <div className="space-y-2">
        <Field htmlFor="expense-category" label={t('category')} error={errors.categoryId} required>
          {/*
            Keyed on the number of bands added here, so adding one remounts the
            select. Radix keeps a controlled value that was present when it
            mounted, but discards one set while its list is closed, because the
            item backing it has never registered. That left a freshly created
            band created, listed, and not selected (docs/gotchas.md).
          */}
          <Select key={added.length} value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger id="expense-category">
              <SelectValue placeholder={t('categoryPlaceholder')}>
                {allCategories.find((category) => category.id === categoryId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {allCategories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {canManageCategories && !addingCategory ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1 text-xs"
            disabled={done}
            onClick={() => setAddingCategory(true)}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('newCategory')}
          </Button>
        ) : null}
      </div>

      <Field htmlFor="expense-payee" label={t('payee')} error={errors.payee} required>
        <Input
          id="expense-payee"
          value={payee}
          maxLength={200}
          placeholder={t('payeePlaceholder')}
          invalid={Boolean(errors.payee)}
          onChange={(event) => setPayee(event.target.value)}
        />
      </Field>

      {addingCategory ? (
        // Across the row, so the new band's own fields have the room.
        <div className="md:col-span-2 xl:col-span-3">
          <NewCategoryFields
            tenant={tenant}
            token={token}
            existing={allCategories}
            onCancel={() => setAddingCategory(false)}
            onCreated={(category) => {
              /*
                No refetch while this form is open: reloading the categories
                query rebuilt the option list under the select, and Radix
                answered the churn with an empty selection. The new band is
                already in hand, and `NewCategoryFields` has written it into
                the cached list, so the register's filter and the next form
                have it without a read.
              */
              setAdded((current) => [...current, category]);
              setCategoryId(category.id);
              setAddingCategory(false);
            }}
          />
        </div>
      ) : null}

      {/* A request has no date and no back-dating: the money leaves on the day of the order. */}
      {pays ? (
        <Field htmlFor="expense-date" label={t('paidOn')} error={errors.paidOn} required>
          <DatePicker
            id="expense-date"
            value={paidOn}
            max={today}
            locale={locale === 'en' ? 'en' : 'ar'}
            onChange={(value) => setPaidOn(value || today)}
          />
        </Field>
      ) : null}

      <div className="space-y-3">
        <Field
          htmlFor="expense-invoice"
          label={t('invoiceNumber')}
          error={errors.invoiceNumber}
          optionalLabel={t('optional')}
        >
          <Input
            id="expense-invoice"
            value={invoiceNumber}
            maxLength={100}
            placeholder={t('invoicePlaceholder')}
            onChange={(event) => setInvoiceNumber(event.target.value)}
          />
        </Field>

        <label htmlFor="expense-receipt" className="flex cursor-pointer items-start gap-2 text-sm">
          <Checkbox
            id="expense-receipt"
            checked={hasPhysicalReceipt}
            onCheckedChange={(checked) => setHasPhysicalReceipt(checked === true)}
            className="mt-0.5"
          />
          <span>{t('hasPhysicalReceipt')}</span>
        </label>
      </div>

      {backdated ? (
        <Field
          htmlFor="expense-adjustment"
          label={t('adjustmentReason')}
          error={errors.adjustmentReason}
          required
          className="md:col-span-2 xl:col-span-3"
        >
          <Input
            id="expense-adjustment"
            value={adjustmentReason}
            maxLength={500}
            placeholder={t('adjustmentPlaceholder')}
            invalid={Boolean(errors.adjustmentReason)}
            onChange={(event) => setAdjustmentReason(event.target.value)}
          />
        </Field>
      ) : null}

      <Field
        htmlFor="expense-description"
        label={t('reason')}
        error={errors.description}
        required
        className="md:col-span-2 xl:col-span-3"
      >
        <Textarea
          id="expense-description"
          rows={2}
          maxLength={1000}
          className="min-h-20"
          value={description}
          placeholder={t('reasonPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
    </>
  );
}
