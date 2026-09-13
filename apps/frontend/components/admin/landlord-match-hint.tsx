'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, UserCheck, X } from 'lucide-react';
import { getLandlordCandidate, logApiError, type LandlordCandidate } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

const LOOKUP_DEBOUNCE_MS = 500;

/**
 * Asks, while the officer is still typing, whether the owner they are naming is
 * somebody the register already holds — and takes the answer.
 *
 * ## Why this asks rather than merely says
 *
 * It used to be a read-only line ending «يمكن ربطه كمالك بعد حفظ هذا السجل»,
 * on the reasoning that the card has not been saved yet, so there is no
 * `PropertyEntry` for a link to attach to — and that offering the link here
 * would mean the browser asserting one the server had to take on trust.
 *
 * The first half is true and the second was never true. `LandlordLinkService`
 * `confirm` re-derives the match from the committed card: it refuses any
 * citizen whose `phone` and `whatsapp` both differ from the card's
 * `landlordPhone`, refuses a card naming its own filer, and refuses an OWNER
 * card. Nothing a browser sends can invent a link. What only a browser has is
 * the officer standing at the door with the tenant in front of them, which is
 * the one moment this question is cheap to answer.
 *
 * So the ordering problem is solved by ordering: the answer is recorded on the
 * card as `landlordCitizenId`, travels with the submission, and the server
 * makes the link against the row it has just written. That also survives the
 * offline queue, which a post-save confirmation from the tab would not — and
 * offline is how most of these records are filed.
 *
 * ## What agreeing changes on the form
 *
 * `landlordName` is filled from the register and locked, the same way
 * `buildingName` locks to `Building.name` when a card is linked to a censused
 * structure: where the register already holds the answer, the field states it
 * rather than inviting a second spelling of it. «فتح للتعديل» unlocks and
 * withdraws the agreement together, because they are one decision — a name the
 * officer is free to retype is not a name the register vouched for.
 *
 * ## Silent is the common case, and silence is not «no»
 *
 * Nothing renders for a number that matches nobody. Most landlords genuinely
 * are unregistered — that is the whole gap this feature exists in — and a line
 * reading «غير مسجَّل» on nine cards out of ten is a line people stop seeing,
 * on the tenth too.
 *
 * The server also answers `null` where *several* citizens share the number, and
 * that silence carries a different meaning the UI deliberately does not try to
 * express. A shared household line is exactly where guessing is worst, and the
 * queue shows all the candidates to somebody who can choose between them.
 */
export function LandlordMatchHint({
  tenant,
  token,
  phone,
  locale = 'ar',
  agreedCitizenId,
  onAgree,
  onWithdraw,
}: {
  tenant: string;
  token: string;
  phone: string;
  locale?: string;
  /** The card's standing answer, so the control re-opens showing it. */
  agreedCitizenId?: string;
  /** «نعم، هو المالك» — the officer took the register's answer for this number. */
  onAgree: (candidate: LandlordCandidate) => void;
  /** «ليس هو» here, and «فتح للتعديل» on the locked name — one decision. */
  onWithdraw: () => void;
}) {
  const en = locale === 'en';
  const [candidate, setCandidate] = useState<LandlordCandidate | null>(null);
  const [looking, setLooking] = useState(false);
  /**
   * «ليس هو», held on the control and not on the card.
   *
   * Rejecting here settles nothing in the register — there is no claim yet to
   * dismiss — so it is not sent anywhere and does not survive the form. All it
   * does is stop this card re-asking a question the officer has answered, which
   * is the whole of what «ليس هو» can honestly mean before a save.
   */
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const trimmed = phone.trim();

    /*
      Not asked until there is plausibly a number to ask about.

      The field is typed digit by digit, and every prefix of a real number is a
      request. Eight digits is the shortest thing `internationalPhone` accepts,
      so below that there is nothing the server could match even in principle.
    */
    if (trimmed.replace(/\D/g, '').length < 8) {
      setCandidate(null);
      setLooking(false);
      return;
    }

    let cancelled = false;
    setLooking(true);

    const timer = setTimeout(() => {
      getLandlordCandidate(tenant, token, trimmed)
        .then((found) => {
          if (!cancelled) setCandidate(found);
        })
        .catch((caught) => {
          /*
            A lookup the officer cannot make must not obstruct the card.

            This is an enrichment on a form that is mostly used in the field,
            frequently offline, and the registration is completely valid without
            it. Logged, and the control simply says nothing — the same thing it
            says for a number that matches nobody. The claim is still written to
            the card and still reaches the queue, so nothing is lost but the
            chance to confirm it early.
          */
          logApiError(caught);
          if (!cancelled) setCandidate(null);
        })
        .finally(() => {
          if (!cancelled) setLooking(false);
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tenant, token, phone]);

  /*
    A new number is a new question.

    The agreement itself is dropped by the field that owns it — changing the
    phone clears `landlordCitizenId` on the card, mirroring the server's own
    `landlordLinkReset` — and this drops the local refusal beside it, so a
    corrected digit does not stay silently answered «ليس هو».
  */
  useEffect(() => {
    setRejected(false);
  }, [phone]);

  if (looking) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {en ? 'Checking the register…' : 'جارٍ البحث في السجل…'}
      </p>
    );
  }

  if (!candidate) return null;

  const agreed = agreedCitizenId === candidate.id;

  /*
    Answered «ليس هو», and nothing more is said about it.

    Not a standing «غير مطابق» banner: the officer has dealt with it, the claim
    goes to the queue as it always did, and a line that keeps restating a
    settled question is the kind people learn to scroll past.
  */
  if (rejected && !agreed) return null;

  return (
    <div
      className={`mt-1.5 rounded-md border px-2.5 py-2 text-xs leading-relaxed ${
        agreed ? 'border-success/40 bg-success/10' : 'border-success/30 bg-success/5'
      }`}
    >
      <p className="flex items-start gap-2">
        <UserCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
        <span>
          <span className="font-medium">
            {en ? 'This number belongs to a registered citizen: ' : 'هذا الرقم يعود لمواطن مسجَّل: '}
            {candidate.name}
          </span>
          {candidate.referenceNumber ? (
            <span className="text-muted-foreground" dir="ltr">
              {' '}
              ({candidate.referenceNumber})
            </span>
          ) : null}
        </span>
      </p>

      {agreed ? (
        <p className="mt-1 ps-5.5 text-muted-foreground">
          {en
            ? 'Recorded as the owner. The link is made when this record is saved.'
            : 'سيُسجَّل مالكاً لهذه البطاقة عند حفظ السجل.'}
        </p>
      ) : (
        <>
          <p className="mt-1 ps-5.5 text-muted-foreground">
            {en
              ? 'Is this the owner? Saying yes records the link with this registration.'
              : 'هل هو المالك؟ الموافقة تربطه بالبطاقة عند الحفظ.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 ps-5.5">
            <Button type="button" size="sm" onClick={() => onAgree(candidate)}>
              <Check className="size-4" aria-hidden />
              {en ? 'Yes, this is the owner' : 'نعم، هو المالك'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setRejected(true);
                onWithdraw();
              }}
            >
              <X className="size-4" aria-hidden />
              {en ? 'No, someone else' : 'لا، شخص آخر'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
