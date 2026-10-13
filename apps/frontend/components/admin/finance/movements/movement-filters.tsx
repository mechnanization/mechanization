'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Filter, X } from 'lucide-react';
import {
  DEFAULT_MOVEMENT_PERIOD,
  MOVEMENT_PERIODS,
  type MovementDirectionParam,
  type MovementPeriod,
} from '@/lib/treasury-movements';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { FilterSelect } from '@/components/ui/filter-controls';
import { SearchField } from '@/components/ui/search-field';

/**
 * The filter bar at the top of «الحركات المالية»'s frame: a search over both
 * kinds of voucher, then the period, which way the money went, through which
 * wallet, under which category, and whether the cancelled vouchers are listed
 * among the others. Drawn as `DataTable`'s own toolbar and filter bar are — the
 * search on a row of its own, the selects on a muted band under it, both inside
 * the frame of the lines they narrow — so it reads like every other register.
 *
 * The period defaults to this month; «فترة أخرى…» opens two day pickers beside
 * it. The category needs the direction first: an income category and an
 * expense band are two different lists, and a category filter with «القبض
 * والصرف» would have to drop one half of the books without saying so. Until a
 * direction is chosen the select is off and says why. Changing the direction
 * clears it.
 *
 * The search term is the page's (`useTabSearch`, never the URL: it can hold a
 * person's name); it runs on Enter (`SearchField`).
 *
 * Below `sm` the selects fold behind «الفلاتر», which counts the ones set, as
 * `DataTable` does on a phone: unfolded, they pushed the first line off the
 * first screen.
 */
export function MovementFilters({
  locale,
  search,
  onSearch,
  period,
  onPeriod,
  from,
  onFrom,
  to,
  onTo,
  direction,
  onDirection,
  accountId,
  onAccount,
  accountOptions,
  categoryId,
  onCategory,
  categoryOptions,
  includeVoid,
  onIncludeVoid,
  onClear,
}: {
  locale: string;
  search: string;
  onSearch: (term: string) => void;
  period: MovementPeriod;
  onPeriod: (period: MovementPeriod) => void;
  /** The range of one's own, for `custom`: business days, or '' while unset. */
  from: string;
  onFrom: (day: string) => void;
  to: string;
  onTo: (day: string) => void;
  direction: MovementDirectionParam;
  onDirection: (direction: MovementDirectionParam) => void;
  accountId: string;
  onAccount: (accountId: string) => void;
  accountOptions: Array<{ value: string; label: string }>;
  categoryId: string;
  onCategory: (categoryId: string) => void;
  /** The chosen direction's categories; empty while no direction is chosen. */
  categoryOptions: Array<{ value: string; label: string }>;
  includeVoid: boolean;
  onIncludeVoid: (includeVoid: boolean) => void;
  /** Back to this month, both directions, every wallet and category, no cancelled, no search. */
  onClear: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.movements');
  const selectsId = useId();
  /** On a phone the selects fold behind one button, so the first lines reach the first screen. */
  const [open, setOpen] = useState(false);
  const active = [period !== DEFAULT_MOVEMENT_PERIOD, direction !== 'all', Boolean(accountId), Boolean(categoryId), includeVoid].filter(
    Boolean,
  ).length;
  const clearable = active > 0 || Boolean(search);
  const pickerLocale = locale === 'en' ? 'en' : 'ar';

  const clear = (
    <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 text-xs" onClick={onClear}>
      <X className="size-3.5" aria-hidden />
      {t('filters.clear')}
    </Button>
  );

  return (
    <>
      <div className="flex items-center gap-2 border-b p-3">
        <SearchField
          className="min-w-0 flex-1 sm:max-w-md"
          value={search}
          onCommit={onSearch}
          placeholder={t('filters.searchPlaceholder')}
          ariaLabel={t('filters.searchAria')}
          clearLabel={t('filters.clearSearch')}
          hint={t('filters.searchHint')}
        />
        {/* `DataTable`'s own phone pattern (UX-1): the filters behind a button that counts the set ones. */}
        <Button
          type="button"
          variant={open || active > 0 ? 'secondary' : 'outline'}
          size="sm"
          className={cn('h-9 shrink-0 gap-1.5 text-xs sm:hidden', active > 0 && 'border-primary/50 font-medium text-primary')}
          aria-expanded={open}
          aria-controls={selectsId}
          onClick={() => setOpen((current) => !current)}
        >
          <Filter className="size-3.5" aria-hidden />
          {t('filters.toggle')}
          {active > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary">
              {active}
            </span>
          ) : null}
        </Button>
        {clearable ? <div className="ms-auto hidden sm:block">{clear}</div> : null}
      </div>

      <div id={selectsId} className={cn('border-b bg-muted/20 px-3.5 py-2.5', open ? 'block' : 'hidden sm:block')}>
        {/* Each select its own width, wrapping as a row runs out, as the other registers' filter bars do. */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <FilterSelect
            label={t('period.label')}
            value={period === 'all' ? '' : period}
            onChange={(value) => onPeriod(value === '' ? 'all' : value)}
            allLabel={t('period.all')}
            options={MOVEMENT_PERIODS.filter((value) => value !== 'all').map((value) => ({
              value,
              label: t(`period.${value}`),
            }))}
          />
          {period === 'custom' ? (
            <div className="col-span-2 grid grid-cols-2 gap-2 sm:flex sm:items-center">
              {/* Named by a label, not only by the placeholder a picked day replaces. */}
              <label htmlFor="movements-from" className="sr-only">
                {t('period.from')}
              </label>
              <DatePicker
                id="movements-from"
                value={from}
                onChange={onFrom}
                max={to || undefined}
                placeholder={t('period.from')}
                locale={pickerLocale}
              />
              <label htmlFor="movements-to" className="sr-only">
                {t('period.to')}
              </label>
              <DatePicker
                id="movements-to"
                value={to}
                onChange={onTo}
                min={from || undefined}
                placeholder={t('period.to')}
                locale={pickerLocale}
              />
            </div>
          ) : null}
          <FilterSelect
            label={t('filters.direction')}
            value={direction === 'all' ? '' : direction}
            onChange={(value) => onDirection(value === '' ? 'all' : value)}
            allLabel={t('filters.allDirections')}
            options={[
              { value: 'in', label: t('filters.in') },
              { value: 'out', label: t('filters.out') },
            ]}
          />
          <FilterSelect
            label={t('filters.account')}
            value={accountId}
            onChange={onAccount}
            allLabel={t('filters.allAccounts')}
            options={accountOptions}
          />
          <FilterSelect
            label={t('filters.category')}
            value={categoryId}
            onChange={onCategory}
            allLabel={direction === 'all' ? t('filters.categoryNeedsDirection') : t('filters.allCategories')}
            options={categoryOptions}
          />
          <FilterSelect
            label={t('filters.status')}
            value={includeVoid ? 'all' : ''}
            onChange={(value) => onIncludeVoid(value === 'all')}
            allLabel={t('filters.recordedOnly')}
            options={[{ value: 'all', label: t('filters.includeCancelled') }]}
          />
          {clearable ? <div className="col-span-2 sm:hidden">{clear}</div> : null}
        </div>
      </div>
    </>
  );
}
