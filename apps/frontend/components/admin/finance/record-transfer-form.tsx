'use client';

import { Alert } from '@/components/ui/alert';
import { AmountFields } from './transfer-form/amount-fields';
import { PaperworkFields } from './transfer-form/paperwork-fields';
import { TransferSummary } from './transfer-form/transfer-summary';
import { useRecordTransfer, type RecordTransferProps } from './transfer-form/use-record-transfer';
import { WalletFields } from './transfer-form/wallet-fields';

/**
 * «تحويل داخلي» and «مصارفة» — money between two working wallets, on a page of
 * its own (BAN-10: a form worked through with a Whish statement or a صرّاف's
 * slip in hand).
 *
 * ## What the summary answers
 *
 * «هل يكفي؟» for the source — which loses the amount *and* the fee — and what
 * the destination will hold, while the figures are typed. The server judges the
 * same thing under both wallets' locks (FRM-4); this only saves the round trip.
 *
 * ## The rate
 *
 * An exchange is two amounts: what left, what arrived. The rate is what they
 * imply, so the server takes the two amounts and derives it. Here the officer
 * may type either the received amount or the rate the صرّاف quoted, and the
 * other follows; what is sent is the two amounts. The rate is judged against the
 * municipality's own by `judgeExchange`, the function the server refuses with,
 * so the warning and the refusal cannot disagree.
 *
 * Recording moves money, so a second press is guarded by an in-flight ref and a
 * retry key the server honours and binds to the act (STA-4). The key follows
 * `keyIsSpent` (`lib/request-id.ts`): held across failures and unmounts, spent
 * only when the server confirms the act; after a 2xx the form stays locked
 * until the page moves on, and a replay is announced as already recorded.
 *
 * ## Where each part is
 *
 * `useRecordTransfer` holds the state and the press; `WalletFields`,
 * `AmountFields`, `PaperworkFields` and `TransferSummary` draw it, all in
 * `transfer-form/`. This component lays the fields beside the summary, with what
 * went wrong under them.
 */
export function RecordTransferForm({
  locale,
  backHref,
  ...props
}: RecordTransferProps & {
  locale: string;
  /** Where «إلغاء» goes. */
  backHref: string;
}): React.JSX.Element {
  const form = useRecordTransfer(props);
  const { formError, submit } = form;
  const { rate } = props;

  return (
    <form noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start" onSubmit={submit}>
      <div className="space-y-6">
        <WalletFields form={form} locale={locale} />
        <AmountFields form={form} rate={rate} locale={locale} />
        <PaperworkFields form={form} locale={locale} />

        {formError ? (
          <Alert variant="destructive" live="alert">
            {formError}
          </Alert>
        ) : null}
      </div>

      <TransferSummary form={form} rate={rate} locale={locale} backHref={backHref} />
    </form>
  );
}
