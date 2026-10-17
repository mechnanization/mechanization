'use client';

import { useTranslations } from 'next-intl';
import { BanknoteArrowDown, BanknoteArrowUp } from 'lucide-react';
import type { TreasuryMovement } from '@/lib/api-client';
import { formatDay, formatDayLong } from '@/lib/dates';
import { isAwaitingOrder, movementCategory, movementKey, movementParty } from '@/lib/treasury-movements';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { TreasuryAmount } from '../treasury-amount';

/**
 * The lines of «الحركات المالية»: every voucher of the page, newest first, one
 * row each — its day first, then who, then the number, the category and the
 * wallet, then the amount at the end.
 *
 * ## Rows, not a table of columns
 *
 * A row reads in the order the cash book is read: the day, the party over the
 * voucher's number, category and wallet, and the signed amount over «قبض» or
 * «صرف». Chosen on 2026-10-12 over a `DataTable`'s seven columns, and over
 * grouping the lines under day headings: the day is a column of its own, so the
 * list is one frame with the filter bar over it. The UI
 * standards record the exception (PRIM-3).
 *
 * From `sm` the day is a column at the line's start. On a phone it heads the
 * line under the party, where a column would take the width the amount needs.
 *
 * ## Direction
 *
 * Money received is in the success colour with its «+», and a banknote going
 * up; money paid out is in the ink with its «−», and a banknote going down —
 * the same pictures the nav gave the two registers. The sign and the word under
 * the figure carry it without the colour (COL-3), and on paper. A cancelled
 * voucher stays in the list, struck through and dimmed, with «ملغى» beside its
 * number: an auditor asking what happened to RV-2610-0004 is owed the answer.
 *
 * Each line is one button: it opens the voucher in a side panel over the list
 * (`VoucherSheet`). The open voucher's line is marked with the selection colour
 * and `aria-current`.
 */
export function MovementList({
  locale,
  movements,
  selectedKey,
  onSelect,
  fetching,
}: {
  locale: string;
  movements: readonly TreasuryMovement[];
  selectedKey: string | null;
  onSelect: (movement: TreasuryMovement) => void;
  /** A re-read is out: the lines on screen are dimmed, not replaced. */
  fetching: boolean;
}): React.JSX.Element {
  const t = useTranslations('finance.movements.list');
  return (
    // The frame's last part when one page holds every line: it rounds its own foot.
    <ol
      aria-label={t('aria')}
      className={cn('divide-y transition-opacity last:overflow-hidden last:rounded-b-lg', fetching && 'opacity-70')}
    >
      {movements.map((movement) => {
        const key = movementKey(movement);
        return (
          <MovementRow key={key} movement={movement} locale={locale} selected={key === selectedKey} onSelect={onSelect} />
        );
      })}
    </ol>
  );
}

function MovementRow({
  movement,
  locale,
  selected,
  onSelect,
}: {
  movement: TreasuryMovement;
  locale: string;
  selected: boolean;
  onSelect: (movement: TreasuryMovement) => void;
}): React.JSX.Element {
  const t = useTranslations('finance.movements.list');
  const voucher = movement.voucher;
  const incoming = movement.direction === 'IN';
  const cancelled = voucher.status === 'VOID';
  const awaiting = isAwaitingOrder(movement);
  const category = movementCategory(movement, locale);
  // An income voucher may name no payer; its category is then what it is.
  const title = movementParty(movement) ?? category;
  const Icon = incoming ? BanknoteArrowUp : BanknoteArrowDown;
  const day = formatDay(movement.day);
  // The weekday and the month in words, for whoever hovers the short date.
  const dayLong = formatDayLong(movement.day, locale);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(movement)}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4',
          selected ? 'bg-primary/10' : 'hover:bg-muted/50',
        )}
      >
        {/* The day, a column of its own from `sm`: `dd/mm/yyyy` in Latin digits, never broken. */}
        <time
          dateTime={movement.day}
          title={dayLong}
          className="hidden w-24 shrink-0 whitespace-nowrap text-sm tabular-nums text-muted-foreground sm:block"
        >
          {day}
        </time>

        <span
          aria-hidden
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md',
            incoming ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="size-4" />
        </span>

        <span className="min-w-0 flex-1 space-y-0.5">
          {/*
            The line keeps the page's alignment; the name inside it takes its own
            direction and its own ellipsis (`dir="auto"` on an inline-block): an
            Arabic payee on the English page is cut at its own end, not its
            beginning, and still starts at the line's start like the meta under it.
          */}
          <span className="block min-w-0 text-sm font-medium text-foreground">
            <bdi dir="auto" className="inline-block max-w-full truncate align-top" title={title}>
              {title}
            </bdi>
          </span>
          {/*
            The status, then (on a phone, the day and) the number, the category and
            the wallet, each isolated (`<bdi>`, RTL-2) so a Latin wallet name never
            reorders the line. One line from `sm`. On a phone the text takes its own
            line under the status and may run to two: beside the badge it was
            squeezed to a letter.
          */}
          <span
            className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground sm:flex-nowrap"
            title={`${voucher.voucherNumber} · ${category} · ${voucher.account.name}`}
          >
            {cancelled ? (
              <Badge variant="soft-warning" className="shrink-0">
                {t('cancelled')}
              </Badge>
            ) : awaiting ? (
              <Badge variant="soft-warning" className="shrink-0">
                {t('awaitingOrder')}
              </Badge>
            ) : null}
            <span className="min-w-0 max-sm:basis-full max-sm:line-clamp-2 sm:truncate">
              <span className="sm:hidden">
                <time dateTime={movement.day} className="whitespace-nowrap tabular-nums">
                  {day}
                </time>
                {' · '}
              </span>
              {/* A voucher number is a code: `font-mono`, Latin, left to right, never broken (BAN-9, RTL-2). */}
              <bdi dir="ltr" className="whitespace-nowrap font-mono">
                {voucher.voucherNumber}
              </bdi>
              {' · '}
              <bdi>{category}</bdi>
              {' · '}
              <bdi>{voucher.account.name}</bdi>
            </span>
          </span>
        </span>

        <span className="shrink-0 text-end">
          <TreasuryAmount
            amount={incoming ? voucher.amount : -voucher.amount}
            currency={voucher.currency}
            locale={locale}
            signed
            className={cn(
              'block text-sm font-semibold',
              cancelled ? 'text-muted-foreground line-through' : incoming ? 'text-success' : 'text-foreground',
            )}
          />
          <span className="block text-xs text-muted-foreground">{incoming ? t('in') : t('out')}</span>
        </span>
      </button>
    </li>
  );
}

/** The shape the lines leave while the first page loads, so the frame does not jump. */
export function MovementListSkeleton(): React.JSX.Element {
  return (
    <div className="divide-y" aria-hidden>
      {Array.from({ length: 6 }, (_, row) => (
        <div key={row} className="flex items-center gap-3 px-3 py-3 sm:px-4">
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
