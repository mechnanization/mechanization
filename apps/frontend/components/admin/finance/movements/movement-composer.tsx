'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BanknoteArrowDown, BanknoteArrowUp, X } from 'lucide-react';
import type { ExpenseCategoryView, IncomeCategoryView, TreasuryAccountView } from '@/lib/api-client';
import { EMPTY_DRAFT, type ComposerDirection, type MovementDraft } from '@/lib/treasury-movements';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ActionTooltip } from '@/components/ui/tooltip';
import { RecordExpenseForm, type RecordOutcome } from '../record-expense-form';
import { RecordIncomeForm } from '../record-income-form';

/** What the last press wrote, for the line above the next entry. */
type LastEntry =
  | {
      kind: 'VOUCHER';
      direction: ComposerDirection;
      id: string;
      voucherNumber: string;
      /** An earlier press wrote it and its answer was lost: that voucher stands, as first recorded. */
      replayed: boolean;
      /** An accountant's urgent payment, paid before the head's order (art. 35). */
      awaitingOrder: boolean;
    }
  | { kind: 'REQUESTED'; replayed: boolean };

/** Where the next entry's figure is typed, per side: what a wide screen focuses after a press. */
const AMOUNT_FIELD: Record<ComposerDirection, string> = { in: 'income-amount', out: 'expense-amount' };

/**
 * A mouse or a trackpad: a keyboard is in hand, and the next figure takes the
 * focus. Not on a touch screen, where focus would raise the keyboard over the
 * confirmation the clerk is reading.
 */
const KEYBOARD = '(pointer: fine)';

/**
 * The recording page's form («الإيرادات والنفقات»): the next receipt or
 * payment, one switch between them, and the form for the one chosen.
 *
 * ## One composer, two acts
 *
 * «قبض» and «صرف» stay two forms with their own rules (`RecordIncomeForm`,
 * `RecordExpenseForm`): different wallets may take part, a payment may need the
 * head's order, an income voucher never does. What they share is carried across
 * the switch — the figure, the wallet, the other party, the wording
 * (`MovementDraft`) — so a clerk who starts typing the amount before choosing
 * the direction loses nothing by choosing it second.
 *
 * ## Recording is the start of the next entry
 *
 * A form that has recorded stays locked (a second press would be a second
 * act), so after each voucher the composer mounts a fresh one — `round` in its
 * key — and says above it what the server wrote (STA-6): the number it gave,
 * with print and view one press away; or, in the warning colour, that an
 * earlier press had already written it and nothing new was recorded; or that a
 * request went to the head's queue. With a keyboard in hand the next figure
 * takes the focus. «عرض» opens the voucher in «الحركات المالية».
 *
 * The confirmation is here and not also a toast (PRIM-18's exception for a form
 * that stays for the next act): the toast said the same thing and lay over the
 * next entry's submit button. It is not a banner that never clears either: the
 * next act replaces it, «مسح» and a switch of direction clear it, and it closes.
 *
 * Who may record is the page's question (`TREASURY_WORK_ROLES`, and a live
 * treasury); the composer is only rendered for them.
 */
export function MovementComposer({
  tenant,
  token,
  locale,
  role,
  direction,
  onDirectionChange,
  accounts,
  incomeCategories,
  expenseCategories,
  urgentCeilings,
  onRecorded,
  voucherHref,
  printHref,
  queueHref,
}: {
  tenant: string;
  token: string;
  locale: string;
  role: string | undefined;
  direction: ComposerDirection;
  onDirectionChange: (direction: ComposerDirection) => void;
  /** The active wallets: each form offers those its act may use. */
  accounts: TreasuryAccountView[];
  incomeCategories: IncomeCategoryView[];
  expenseCategories: ExpenseCategoryView[];
  urgentCeilings?: Partial<Record<string, number | null>>;
  /** A press is answered: the page brings the confirmation, at the composer's top, into view. */
  onRecorded: () => void;
  /** The voucher in «الحركات المالية», open in its side panel. */
  voucherHref: (direction: ComposerDirection, voucherId: string) => string;
  printHref: (direction: ComposerDirection, voucherId: string) => string;
  /** What waits on the head's order, where a request goes. */
  queueHref: string;
}): React.JSX.Element {
  const t = useTranslations('finance.movements.composer');
  const tIn = useTranslations('finance.income.form');
  const tOut = useTranslations('finance.expenses.form');
  const [round, setRound] = useState(0);
  const [last, setLast] = useState<LastEntry | null>(null);
  /** The shared fields as last typed, read by whichever form mounts next. */
  const draft = useRef<MovementDraft>(EMPTY_DRAFT);
  const keepDraft = useCallback((next: MovementDraft) => {
    draft.current = next;
  }, []);

  /** A fresh, empty form: after a recorded act, or on «مسح». */
  const startOver = (): void => {
    draft.current = EMPTY_DRAFT;
    setRound((current) => current + 1);
  };

  const recorded = (entry: LastEntry): void => {
    setLast(entry);
    startOver();
    onRecorded();
  };

  /*
    After a press, with a keyboard in hand, the next figure is where it goes —
    without scrolling: the page brings the confirmation above it into view, and
    focus would scroll the page under it.
  */
  const pressed = useRef(false);
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    if (window.matchMedia(KEYBOARD).matches) document.getElementById(AMOUNT_FIELD[direction])?.focus({ preventScroll: true });
  }, [round, direction]);

  const confirmation = last ? renderConfirmation(last) : null;

  /** The line above the next entry, for what the last press wrote. A render helper, not a component: nothing in it keeps state. */
  function renderConfirmation(entry: LastEntry): React.JSX.Element {
    const actions =
      entry.kind === 'VOUCHER' ? (
        <span className="flex gap-1">
          <Button asChild variant="link" size="sm" className="h-auto p-0">
            <Link href={printHref(entry.direction, entry.id)}>{t('print')}</Link>
          </Button>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <Button asChild variant="link" size="sm" className="h-auto p-0">
            <Link href={voucherHref(entry.direction, entry.id)}>{t('view')}</Link>
          </Button>
        </span>
      ) : (
        <Button asChild variant="link" size="sm" className="h-auto p-0">
          <Link href={queueHref}>{t('openQueue')}</Link>
        </Button>
      );

    const code = (chunks: React.ReactNode): React.JSX.Element => (
      <bdi dir="ltr" className="font-mono text-xs font-medium">
        {chunks}
      </bdi>
    );

    const { title, body } =
      entry.kind === 'REQUESTED'
        ? entry.replayed
          ? { title: tOut('requestReplayed'), body: tOut('requestReplayedBody') }
          : { title: t('requested'), body: null }
        : entry.replayed
          ? {
              title: (entry.direction === 'in' ? tIn : tOut)('replayed', { number: entry.voucherNumber }),
              body: (entry.direction === 'in' ? tIn : tOut)('replayedBody'),
            }
          : {
              title: t.rich(entry.direction === 'in' ? 'recordedIn' : 'recordedOut', { number: entry.voucherNumber, code }),
              body:
                entry.direction === 'in'
                  ? tIn('successBody')
                  : entry.awaitingOrder
                    ? tOut('urgentSuccessBody')
                    : tOut('successBody'),
            };

    return (
      <Alert variant={entry.replayed ? 'warning' : 'success'} live="status">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">{title}</p>
            {body ? <p className="text-xs">{body}</p> : null}
            {actions}
          </div>
          <ActionTooltip label={t('dismiss')}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-me-1 -mt-1 shrink-0"
              aria-label={t('dismiss')}
              onClick={() => setLast(null)}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </ActionTooltip>
        </div>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <SegmentedControl
        value={direction}
        onChange={(next) => {
          setLast(null);
          onDirectionChange(next as ComposerDirection);
        }}
        aria-label={t('directionAria')}
        options={[
          { value: 'in', label: t('in'), icon: BanknoteArrowUp },
          { value: 'out', label: t('out'), icon: BanknoteArrowDown },
        ]}
      />

      {confirmation}

      {direction === 'in' ? (
        <RecordIncomeForm
          key={`in-${round}`}
          tenant={tenant}
          token={token}
          locale={locale}
          role={role}
          accounts={accounts}
          categories={incomeCategories}
          initial={draft.current}
          onDraftChange={keepDraft}
          onRecorded={(result) => {
            pressed.current = true;
            recorded({
              kind: 'VOUCHER',
              direction: 'in',
              id: result.id,
              voucherNumber: result.voucherNumber,
              replayed: result.replayed,
              awaitingOrder: false,
            });
          }}
          onClear={() => {
            setLast(null);
            startOver();
          }}
        />
      ) : (
        <RecordExpenseForm
          key={`out-${round}`}
          tenant={tenant}
          token={token}
          locale={locale}
          role={role}
          accounts={accounts}
          categories={expenseCategories}
          urgentCeilings={urgentCeilings}
          initial={draft.current}
          onDraftChange={keepDraft}
          onRecorded={(outcome: RecordOutcome) => {
            pressed.current = true;
            recorded(
              outcome.kind === 'PAID'
                ? {
                    kind: 'VOUCHER',
                    direction: 'out',
                    id: outcome.result.id,
                    voucherNumber: outcome.result.voucherNumber,
                    replayed: outcome.result.replayed,
                    awaitingOrder: outcome.result.orderStatus === 'AWAITING_ORDER',
                  }
                : { kind: 'REQUESTED', replayed: outcome.result.replayed },
            );
          }}
          onClear={() => {
            setLast(null);
            startOver();
          }}
        />
      )}
    </div>
  );
}
