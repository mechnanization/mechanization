'use client';

import { useId } from 'react';
import { getLabels } from '@mechanization/shared-schemas';
import type { TreasuryAccountView } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TreasuryAmount } from './treasury-amount';

/*
  The layout the two recording forms share — «تسجيل نفقة» and «تسجيل إيراد
  جديد» — so an accountant who knows one knows the other (UX-1). Each form keeps
  its own fields, rules and retry key; only the frame lives here.

  ## Two panes from `xl`

  From `xl` the page is the height of the screen and the form fills what the
  heading leaves, in two panes: the fields scroll inside their card, and the
  summary beside them does not move at all. A summary that was `sticky` on the
  page scroll was not fixed: it travelled with the page for the height of the
  back link and the heading before it caught, and on a large screen that was
  most of the page's scroll, so it read as a panel that scrolls away. The page
  that hosts the form makes itself the screen's height (`xl:flex xl:h-full
  xl:flex-col` on its root); the grid takes the rest (`xl:flex-1`), and never
  less than 24rem — on a screen shorter than that the page scrolls as before.

  The panes start at `xl` because the sidebar takes 16rem from `lg`: at 1024px
  two columns left the fields 360px. Below `xl` there is one column and the
  page scrolls as any page does, the summary under the fields, directly above
  the buttons it qualifies.
*/

/**
 * The grid the form and its summary sit in: one column, and from `xl` the
 * fields beside a 20rem summary in one row the height of what the page leaves.
 */
export const TREASURY_FORM_GRID =
  'grid gap-6 xl:min-h-96 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_20rem] xl:grid-rows-[minmax(0,1fr)]';

/**
 * The fields, in one frame that is also their scrolling pane from `xl`: a card
 * whose sections are divided by a rule.
 *
 * Its sections are not cards themselves, which would be the nested frame BAN-4
 * refuses. The fieldset inside it locks every control at once — a press in
 * flight, a recorded act — as the counter's forms do, so the values on screen
 * are the ones the press sent.
 */
export function FormCard({ disabled, children }: { disabled: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <Card className="xl:min-h-0 xl:overflow-y-auto">
      <fieldset disabled={disabled} className="m-0 min-w-0 divide-y border-0 p-0">
        {children}
      </fieldset>
    </Card>
  );
}

/**
 * A group of fields under a heading that reads as one (A11Y-3): `text-sm`,
 * the foreground colour, a real `h2` the section is named by. The muted
 * `text-xs` caption over a rule that it replaces was the size of the field
 * labels under it, so the form had no outline to scan. More air above the
 * heading than below it (LAY-2); no letter-spacing on Arabic (TYP-5).
 */
export function FormSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * «يُدفع من حساب» / «استُلم في حساب» — the wallet, chosen from a list.
 *
 * Closed, it names the wallet and what it is, as the salary dialog's list does.
 * Open, each wallet also says what it holds, so the safe with the money — or
 * the one in the slip's currency — can be picked without choosing each in turn
 * to read the summary. The balance is `TreasuryAmount`, in full, as on the
 * treasury page.
 */
export function WalletSelect({
  id,
  label,
  placeholder,
  accounts,
  value,
  onChange,
  locale,
  error,
}: {
  id: string;
  label: string;
  placeholder: string;
  accounts: readonly TreasuryAccountView[];
  value: string;
  onChange: (accountId: string) => void;
  locale: string;
  error?: string;
}): React.JSX.Element {
  const labels = getLabels(locale);
  const name = (account: TreasuryAccountView): string =>
    `${account.name} · ${labels.treasuryAccountType[account.type]}`;
  const selected = accounts.find((account) => account.id === value);

  return (
    <Field htmlFor={id} label={label} error={error} required>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          {/* The name alone: the balance is the summary's to say once a wallet is chosen. */}
          <SelectValue placeholder={placeholder}>{selected ? name(selected) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>{name(account)}</span>
                <TreasuryAmount
                  amount={account.balance}
                  currency={account.currency}
                  locale={locale}
                  className="text-xs text-muted-foreground"
                />
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * The summary beside the fields: what will be recorded, what it does to the
 * wallet, and the buttons.
 *
 * At its own height, never stretched to the row: a panel as tall as the fields
 * was a frame around empty space. From `xl` it is the second pane and stays
 * where it is while the fields scroll (see the note at the top of this file);
 * should the row be shorter than the panel, its body scrolls and the footer
 * with the buttons never does.
 *
 * `footer` holds the buttons and the refusal of the last press, which is said
 * next to the action it is about (STA-3).
 */
export function SummaryPanel({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  /** The card's own classes — a border tone when the summary is a warning. */
  className?: string;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <aside aria-labelledby={headingId} className="flex min-h-0 flex-col xl:max-h-full xl:self-start">
      <Card className={cn('flex min-h-0 flex-col', className)}>
        <h2 id={headingId} className="border-b px-4 py-3 text-base font-semibold">
          {title}
        </h2>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2">{children}</div>
        <div className="space-y-3 border-t p-4">{footer}</div>
      </Card>
    </aside>
  );
}

/**
 * The shape a recording form leaves, for its page to show while the wallets
 * and the categories load, so the page does not jump when they land: the
 * fields card with its three sections, and the summary panel beside it.
 */
export function TreasuryFormSkeleton(): React.JSX.Element {
  return (
    <div className={TREASURY_FORM_GRID} aria-hidden>
      <Card className="divide-y">
        {Array.from({ length: 3 }, (_, section) => (
          <div key={section} className="space-y-4 p-4 sm:p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </Card>
      <Skeleton className="h-80 w-full rounded-lg" />
    </div>
  );
}
