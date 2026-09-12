'use client';

import { useEffect, useState } from 'react';
import { Loader2, UserCheck } from 'lucide-react';
import { getLandlordCandidate, logApiError, type LandlordCandidate } from '@/lib/api-client';

const LOOKUP_DEBOUNCE_MS = 500;

/**
 * Says, while the officer is still typing, whether the owner they are naming is
 * somebody the register already holds.
 *
 * ## Why this is a hint and not a control
 *
 * It links nothing. The card has not been saved yet, so there is no
 * `PropertyEntry` for a link to attach to — and offering the link here would
 * mean the browser asserting one, which the server would then have to take on
 * trust. The confirmation happens after the save, against a row the server
 * wrote and can verify the number of; see the offers `createCitizen` returns.
 *
 * What it buys instead is the thing an officer at a doorstep actually needs: to
 * find out *now*, while the tenant is in front of them and can correct a digit,
 * that «03 123456» is or is not a number the municipality knows. Discovering it
 * a week later in a queue is when a wrong digit becomes permanent.
 *
 * ## Silent is the common case, and silence is not "no"
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
}: {
  tenant: string;
  token: string;
  phone: string;
  locale?: string;
}) {
  const en = locale === 'en';
  const [candidate, setCandidate] = useState<LandlordCandidate | null>(null);
  const [looking, setLooking] = useState(false);

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
            it. Logged, and the hint simply says nothing — the same thing it
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

  if (looking) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {en ? 'Checking the register…' : 'جارٍ البحث في السجل…'}
      </p>
    );
  }

  if (!candidate) return null;

  return (
    <p className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-xs leading-relaxed">
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
        <span className="mt-0.5 block text-muted-foreground">
          {en
            ? 'You can link them as the owner after saving this record.'
            : 'يمكن ربطه كمالك بعد حفظ هذا السجل.'}
        </span>
      </span>
    </p>
  );
}
