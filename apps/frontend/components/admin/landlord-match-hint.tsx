'use client';

import { useEffect, useId, useState } from 'react';
import { Check, Loader2, UserCheck, X } from 'lucide-react';
import { getLandlordCandidates, logApiError, type LandlordCandidate } from '@/lib/api-client';
import { compareNames } from '@/lib/landlord-display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const LOOKUP_DEBOUNCE_MS = 500;

/**
 * Asks, while the officer is still with the tenant, whether the owner being
 * named is somebody the register already holds — and takes the answer.
 *
 * ## Why it asks here, before the card exists
 *
 * This is the cheapest moment the question will ever have: the tenant can
 * still say «لا، أبوه» or correct a digit. There is no `PropertyEntry` yet, so
 * the answer is recorded on the card as `landlordCitizenId`, travels with the
 * submission (and so survives the offline queue), and the server confirms it
 * against the committed card through the same checks the queue uses. The
 * browser supplies a person's answer and nothing else.
 *
 * ## A shared household line is shown, not hidden
 *
 * It used to say nothing where several citizens share the number, on the
 * reasoning that picking would be guessing. Guessing is exactly what the
 * officer at the door does *not* have to do — the tenant is right there — so
 * every person on the number is listed, each marked with how their name
 * compares with the one typed, and the officer chooses.
 *
 * ## Silent is still the common case
 *
 * A number matching nobody renders nothing. Most landlords are not registered,
 * and a «غير مسجَّل» line on nine cards out of ten is one people stop reading.
 */
export function LandlordMatchHint({
  tenant,
  token,
  phone,
  typedName,
  locale = 'ar',
  agreedCitizenId,
  onAgree,
  onWithdraw,
}: {
  tenant: string;
  token: string;
  phone: string;
  /** What the officer typed as the owner's name, to compare against. */
  typedName?: string;
  locale?: string;
  /** The card's standing answer, so the control re-opens showing it. */
  agreedCitizenId?: string;
  /** «نعم، هو المالك» — the officer took the register's answer for this number. */
  onAgree: (candidate: LandlordCandidate) => void;
  /** «لا أحد منهم» here, and «تغيير» on the locked name — one decision. */
  onWithdraw: () => void;
}) {
  const en = locale === 'en';
  const group = useId();
  const [candidates, setCandidates] = useState<LandlordCandidate[]>([]);
  const [looking, setLooking] = useState(false);
  /**
   * «لا أحد منهم», held on the control and not on the card. There is no claim
   * yet to dismiss, so it is not sent anywhere; it only stops this card
   * re-asking a question the officer has answered.
   */
  const [rejected, setRejected] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = phone.trim();

    // Eight digits is the shortest thing `internationalPhone` accepts, so
    // below that there is nothing the server could match even in principle.
    if (trimmed.replace(/\D/g, '').length < 8) {
      setCandidates([]);
      setLooking(false);
      return;
    }

    const controller = new AbortController();
    setLooking(true);

    const timer = setTimeout(() => {
      getLandlordCandidates(tenant, token, trimmed, controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) setCandidates(found);
        })
        .catch((caught) => {
          /*
            A lookup the officer cannot make must not obstruct the card — this
            form is mostly used in the field, frequently offline, and the
            registration is valid without it. The claim still reaches the queue.
          */
          if (controller.signal.aborted) return;
          logApiError(caught);
          setCandidates([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLooking(false);
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [tenant, token, phone]);

  // A new number is a new question.
  useEffect(() => {
    setRejected(false);
    setChosen(null);
  }, [phone]);

  if (looking) {
    return (
      <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        {en ? 'Checking the register…' : 'جارٍ البحث في السجل…'}
      </p>
    );
  }

  if (candidates.length === 0) return null;

  const agreed = candidates.find((candidate) => candidate.id === agreedCitizenId) ?? null;
  // The locked name field beside this says who was agreed; nothing to repeat.
  if (agreed) return null;
  if (rejected) return null;

  const single = candidates.length === 1;
  const selectedId = single ? candidates[0]!.id : chosen;
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null;

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <UserCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        {single
          ? en
            ? 'This number belongs to a registered citizen. Is this the owner?'
            : 'هذا الرقم يعود لمواطن مسجَّل. هل هو المالك؟'
          : en
            ? `${candidates.length} registered citizens share this number. Which one is the owner?`
            : `${candidates.length} مواطنين مسجَّلين على هذا الرقم. أيّهم المالك؟`}
      </p>

      <div role="radiogroup" className="space-y-1.5">
        {candidates.map((candidate) => {
          const match = compareNames(typedName, candidate.name);
          const isSelected = selectedId === candidate.id;
          return (
            <label
              key={candidate.id}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border bg-card px-2.5 py-2 transition-colors duration-150',
                isSelected ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/50',
              )}
            >
              <input
                type="radio"
                name={group}
                checked={isSelected}
                onChange={() => setChosen(candidate.id)}
                className={cn('size-4 shrink-0 accent-[hsl(var(--primary))]', single && 'sr-only')}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-semibold">{candidate.name}</span>
                  {match === 'SAME' ? (
                    <Badge variant="soft-success">{en ? 'Same name' : 'الاسم مطابق'}</Badge>
                  ) : match === 'SIMILAR' ? (
                    <Badge variant="soft-info">{en ? 'Similar name' : 'اسم مشابه'}</Badge>
                  ) : match === 'DIFFERENT' ? (
                    <Badge variant="soft-warning">{en ? 'Different name' : 'اسم مختلف'}</Badge>
                  ) : null}
                </span>
                <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {candidate.referenceNumber ? (
                    <bdi dir="ltr" className="font-mono">
                      {candidate.referenceNumber}
                    </bdi>
                  ) : null}
                  {candidate.fatherName ? (
                    <span>
                      {en ? 'Father' : 'الأب'}: {candidate.fatherName}
                    </span>
                  ) : null}
                  {candidate.motherName ? (
                    <span>
                      {en ? 'Mother' : 'الأم'}: {candidate.motherName}
                    </span>
                  ) : null}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!selected}
          onClick={() => selected && onAgree(selected)}
          className="h-10 transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none"
        >
          <Check className="size-4" aria-hidden />
          {selected
            ? single
              ? en
                ? 'Yes, this is the owner'
                : 'نعم، هو المالك'
              : en
                ? `${selected.name} is the owner`
                : `${selected.name} هو المالك`
            : en
              ? 'Choose the owner'
              : 'اختر المالك'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setRejected(true);
            onWithdraw();
          }}
          className="h-10"
        >
          <X className="size-4" aria-hidden />
          {single ? (en ? 'No, someone else' : 'لا، شخص آخر') : en ? 'None of them' : 'لا أحد منهم'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {en
          ? 'Saying yes links the owner when this record is saved, and adds the property to their file.'
          : 'الموافقة تربط المالك عند حفظ السجل، ويُضاف العقار إلى ملفه.'}
      </p>
    </div>
  );
}
