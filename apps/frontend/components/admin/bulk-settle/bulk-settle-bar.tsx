'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banknote, X } from 'lucide-react';
import { BULK_SETTLE_MAX_BILLS } from '@mechanization/shared-schemas';
import { dueByCurrency, selectedCitizen } from '@/lib/bulk-settle';
import type { BulkSelection } from '@/lib/use-bulk-selection';
import { Button } from '@/components/ui/button';
import { BulkSettleDialog } from './bulk-settle-dialog';
import { MoneyList } from './money-list';

/**
 * The bar that holds a selection of bills for «تسديد الفواتير المحددة»: how
 * many, whose, what they owe per currency, «تسديد الفواتير المحددة» and
 * «إلغاء التحديد». It opens `BulkSettleDialog`.
 *
 * Sticky at the foot of the page while at least one bill is ticked, so the
 * total is in sight however far down the list the clerk ticks. It must be a
 * direct child of the page's root (`w-full space-y-6 px-4 …`, LAY-1): sticky
 * holds only inside its parent, and the negative margins reach that root's
 * padding, as the review page's save bar does. A solid surface with a rule
 * above it, not a blur (BAN-2).
 */
export function BulkSettleBar({
  tenant,
  base,
  token,
  locale,
  selection,
  onSettled,
  onStale,
}: {
  tenant: string;
  base: string;
  token: string;
  locale: string;
  selection: BulkSelection;
  /** The settlement is recorded and the selection cleared: re-read what the page shows. */
  onSettled: () => void;
  /** A ticked bill was settled since: re-read the bills. */
  onStale: () => void;
}): React.JSX.Element | null {
  const t = useTranslations('bulkSettle.bar');
  const [open, setOpen] = useState(false);
  const { bills } = selection;
  const citizen = selectedCitizen(bills);

  if (!citizen) return null;
  const full = bills.length >= BULK_SETTLE_MAX_BILLS;

  return (
    <>
      <div
        role="region"
        aria-label={t('label')}
        className="sticky bottom-0 z-10 -mx-4 border-t bg-background px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5" aria-live="polite">
            <p className="text-sm font-semibold">{t('count', { count: bills.length })}</p>
            <p className="truncate text-xs text-muted-foreground" title={citizen.name}>
              {t('payer', { name: citizen.name })}
            </p>
            <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
              <span className="text-muted-foreground">{t('due')}</span>
              <MoneyList entries={dueByCurrency(bills)} locale={locale} className="inline-flex flex-wrap items-baseline gap-x-1.5 font-semibold" />
            </p>
            {full ? <p className="text-xs text-muted-foreground">{t('limit', { max: BULK_SETTLE_MAX_BILLS })}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="flex-1 gap-1.5 sm:flex-none" onClick={selection.clear}>
              <X className="size-4" aria-hidden />
              {t('clear')}
            </Button>
            <Button type="button" className="flex-1 gap-1.5 sm:flex-none" onClick={() => setOpen(true)}>
              <Banknote className="size-4" aria-hidden />
              {t('settle')}
            </Button>
          </div>
        </div>
      </div>

      {open ? (
        <BulkSettleDialog
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          bills={bills}
          onRemove={(id) => {
            // The last bill unticked: nothing is left to settle, and the bar goes with the dialog.
            if (bills.length <= 1) setOpen(false);
            selection.remove(id);
          }}
          onClose={() => setOpen(false)}
          onSettled={() => {
            setOpen(false);
            selection.clear();
            onSettled();
          }}
          onStale={onStale}
        />
      ) : null}
    </>
  );
}
