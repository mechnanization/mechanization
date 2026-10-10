'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, logApiError, voidTransfer, type TreasuryStatementEntry } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TreasuryAmount } from './treasury-amount';

/** The shortest reason the server takes (`voidTransferSchema`). */
const REASON_MIN = 5;

/**
 * «إلغاء التسليم» — the manager cancels a collector's handover that should not
 * stand: the count was wrong, or it was recorded against the wrong collector.
 *
 * Opened from the handover's own movement on a wallet's statement. The
 * transfer is stamped, never deleted, and both legs go back: the money leaves
 * the safe and returns to the collector's custody, on his name again, which is
 * the honest answer when the notes counted were not what was recorded. The
 * server refuses when the safe no longer holds the money
 * (`TREASURY_INSUFFICIENT_FUNDS`) — it was paid out or moved since — and when
 * someone cancelled the handover first (`TRANSFER_ALREADY_VOID`). Either way the
 * dialog stays open with the refusal beside the action, and the treasury is
 * re-read behind it so the row shows what is true now.
 *
 * `ConfirmDialog` with `destructive={false}` (DES-4), as `VoidExpenseDialog`:
 * nothing is lost, and the copy says where the money goes. The reason is
 * required, and Confirm waits for it rather than refusing afterwards — the only
 * refusals left to show are the server's, each said once.
 */
export function VoidTransferDialog({
  tenant,
  token,
  locale,
  entry,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** The handover's movement on this wallet; `sourceId` is the transfer. */
  entry: TreasuryStatementEntry;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.statement.voidTransfer');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);

  const amount = Math.abs(entry.amount);

  /**
   * The refusal, in words. `TREASURY_INSUFFICIENT_FUNDS` is said for this act —
   * the safe no longer holds what the handover brought — rather than as a
   * payment the balance cannot cover, which is what its own text describes.
   */
  const refusalText = (caught: unknown): string | null => {
    if (!(caught instanceof ApiRequestError)) return null;
    if (caught.code === 'TREASURY_INSUFFICIENT_FUNDS') {
      const params = caught.payload.params ?? {};
      const currency = String(params.currency ?? entry.currency);
      if (typeof params.available === 'number' && typeof params.required === 'number') {
        return t('insufficient', {
          account: String(params.account ?? ''),
          available: formatMoney(params.available, currency, locale),
          required: formatMoney(params.required, currency, locale),
        });
      }
    }
    return null;
  };

  const confirm = async (): Promise<void> => {
    if (inFlight.current || !entry.sourceId) return;
    inFlight.current = true;
    try {
      const transfer = await voidTransfer(tenant, token, { id: entry.sourceId, reason: reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(t('success', { number: transfer.transferNumber }), { description: t('successBody') });
      onDone();
    } catch (caught) {
      logApiError(caught);
      // Whatever the refusal, the statement behind the dialog may be behind the ledger: re-read it.
      if (caught instanceof ApiRequestError) void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      const text = refusalText(caught);
      // `ConfirmDialog` shows a thrown error's message beside the action, and keeps the dialog open.
      throw text ? new Error(text) : caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('title')}
      description={t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      confirmDisabled={reason.trim().length < REASON_MIN}
      onConfirm={confirm}
    >
      <SummaryList className="rounded-md border bg-muted/20 px-3">
        <SummaryRow label={t('amount')}>
          <TreasuryAmount amount={amount} currency={entry.currency} locale={locale} />
        </SummaryRow>
        <SummaryRow label={t('when')}>
          <span className="tabular-nums">{formatDateTime(entry.occurredAt)}</span>
        </SummaryRow>
        {entry.actorName ? <SummaryRow label={t('recordedBy')}>{entry.actorName}</SummaryRow> : null}
        {entry.note ? <SummaryRow label={t('note')}>{entry.note}</SummaryRow> : null}
      </SummaryList>

      <Field htmlFor="void-transfer-reason" label={t('reason')} required>
        <Textarea
          id="void-transfer-reason"
          rows={2}
          maxLength={500}
          value={reason}
          placeholder={t('reasonPlaceholder')}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}
