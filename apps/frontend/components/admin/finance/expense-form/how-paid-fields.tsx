'use client';

import { useTranslations } from 'next-intl';
import { Send, Zap } from 'lucide-react';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { RecordExpenseState } from './use-record-expense';

/**
 * How the voucher is paid, which only an accountant chooses: the request or the
 * urgent payment, the wallet's ceiling, and why it could not wait. Cells of the
 * form's grid; the manager has none of them.
 */
export function HowPaidFields({ form }: { form: RecordExpenseState }): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const { mode, choice, choose, ceiling, ceilingText, errors, urgentReason, setUrgentReason } = form;

  return (
    <>
      {mode !== 'ORDER' ? (
        <div className="space-y-2 md:col-span-2 xl:col-span-3">
          {/*
            Two ways for an accountant to press the button, side by side, each
            saying what it does: the request (the default, nothing leaves a
            wallet) or the urgent payment (art. 35). Outlined choices, not a
            second filled switch under «قبض | صرف»: on the page the one accent
            belongs to the direction and the submit. What art. 35 covers
            (salaries, petty expenses, an emergency) is in the urgent card.
          */}
          <div role="radiogroup" aria-label={t('how.aria')} className="grid grid-cols-2 gap-2">
            <ChoiceCard
              name="expense-how"
              value="REQUEST"
              checked={choice === 'REQUEST'}
              onChange={() => choose('REQUEST')}
              title={t('how.request')}
              description={t('how.requestBody')}
              icon={Send}
              className="items-start py-2"
            />
            <ChoiceCard
              name="expense-how"
              value="URGENT"
              checked={choice === 'URGENT'}
              onChange={() => choose('URGENT')}
              title={t('how.urgent')}
              description={t('how.urgentBody')}
              icon={Zap}
              className="items-start py-2"
            />
          </div>

          {ceiling !== null ? (
            <p className="text-xs text-muted-foreground">{t('ceiling.note', { ceiling: ceilingText })}</p>
          ) : null}
        </div>
      ) : null}

      {mode === 'URGENT' ? (
        <Field
          htmlFor="expense-urgent"
          label={t('how.urgentReason')}
          error={errors.urgentReason}
          required
          className="md:col-span-2 xl:col-span-3"
        >
          <Textarea
            id="expense-urgent"
            rows={2}
            maxLength={500}
            className="min-h-20"
            value={urgentReason}
            placeholder={t('how.urgentReasonPlaceholder')}
            onChange={(event) => setUrgentReason(event.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}
