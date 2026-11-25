import { Check, FileQuestion, Loader2, Undo2 } from 'lucide-react';
import { approveRecord, returnRecord, type ReviewQueueItem } from '@/lib/quality-api';
import { Button } from '@/components/ui/button';
import { ReturnForm } from './return-form';

/**
 * The foot of a card: the three answers a reviewer has, or the form that
 * returns the record, open in their place.
 */
export function RecordActions({
  item,
  tenant,
  token,
  locale,
  busy,
  returning,
  setReturning,
  setCompleting,
  act,
}: {
  item: ReviewQueueItem;
  tenant: string;
  token: string | null;
  locale: string;
  /** The record a decision is being saved for, or none. */
  busy: string | null;
  /** The record whose return form is open, or none. */
  returning: string | null;
  setReturning: (registrationId: string | null) => void;
  setCompleting: (item: ReviewQueueItem) => void;
  /** The queue's one write: it says what happened and reads the queue again. */
  act: (registrationId: string, run: () => Promise<unknown>, done: string) => void;
}): React.JSX.Element {
  const en = locale === 'en';

  return (
    <>
      {returning === item.registrationId ? (
        <ReturnForm
          locale={locale}
          busy={busy === item.registrationId}
          onCancel={() => setReturning(null)}
          onSubmit={(input) =>
            act(
              item.registrationId,
              () => returnRecord(tenant, token!, item.registrationId, input),
              en ? 'Returned to the officer' : 'أُعيد السجل إلى الموظف',
            )
          }
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/20 px-4 py-3">
          {/*
            «استكمال» sits with the two decisions rather than in the
            flag list above it, because it is the third answer a
            reviewer has and the queue never offered it.

            «اعتماد» and «إعادة إلى الموظف» both assume the gap stays
            a gap: approve it as it is, or send the officer back out.
            A reviewer who can simply *fill it in* — they have the
            deed on the desk, they know the family — had to leave the
            queue, find the citizen, and open a four-step form, and
            the queue they left does not remember where they were. So
            the commonest resolution was the one that cost least to
            click, which is «اعتماد» on a record still missing
            something.

            Safe on every row here without checking which
            registration it is: `RecordReviewService.queue` is
            `DISTINCT ON (citizenId) … ORDER BY submittedAt DESC`, so
            a queue row *is* the citizen's latest registration — the
            one `/citizens/:id/form` returns and this dialog writes.

            Shown with flags only. A record at «عُدِّل بعد الاعتماد»
            with nothing open has no questions to put, and a dialog
            that opens to say «لا توجد معلومات ناقصة» is a button that
            wasted the click.
          */}
          {item.flags.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy === item.registrationId}
              onClick={() => setCompleting(item)}
            >
              <FileQuestion className="size-4" aria-hidden />
              {en ? 'Fill in the gaps' : 'استكمال الناقص'}
            </Button>
          ) : null}
          {item.state !== 'RETURNED' ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy === item.registrationId}
              onClick={() => setReturning(item.registrationId)}
            >
              <Undo2 className="size-4" aria-hidden />
              {en ? 'Return to the officer' : 'إعادة إلى الموظف'}
            </Button>
          ) : null}
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy === item.registrationId}
            onClick={() =>
              act(
                item.registrationId,
                () => approveRecord(tenant, token!, item.registrationId),
                en ? 'Record approved' : 'تم اعتماد السجل',
              )
            }
          >
            {busy === item.registrationId ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            {item.state === 'APPROVED' ? (en ? 'Approve again' : 'إعادة الاعتماد') : en ? 'Approve' : 'اعتماد'}
          </Button>
        </div>
      )}
    </>
  );
}
