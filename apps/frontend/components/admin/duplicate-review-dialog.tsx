'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Ban, ExternalLink, PhoneOff, UsersRound } from 'lucide-react';
import { duplicateMatchedOnLabels } from '@mechanization/shared-schemas';
import type {
  ContactNumberField,
  DuplicateReviewAnswer,
  DuplicateReviewFindings,
} from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { RecordKindBadge } from '@/components/admin/record-kind-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** The same four-character floor every reason in the app has. */
const MIN_REASON = 4;

/**
 * Save as a new record, with the officer's answer attached — and, for any
 * number that is not this person's, the field to empty and the «غير مؤكَّد»
 * reason to flag it with. The phone and a separate WhatsApp number are cleared
 * independently: only the one that was somebody else's goes.
 *
 * `relative` is the other way out for the phone: the number is a relative's
 * and the person has none of their own. The file is saved «لا يملك رقم هاتف»
 * with this number as its «رقم للتواصل», and nothing is flagged — the record is
 * complete, and the number is kept as what it is.
 */
export interface DuplicateReviewOutcome {
  answer: DuplicateReviewAnswer | undefined;
  clear: Partial<Record<ContactNumberField, string>>;
  relative?: string;
}

type PersonAnswer = 'same' | 'different' | null;
type PhoneAnswer = 'shared' | 'notTheirs' | 'relative' | 'fix';

const FIELDS: readonly ContactNumberField[] = ['phone', 'whatsapp'];

/**
 * «قبل الحفظ» — the two questions a save stops for.
 *
 * ## Is this somebody already on file?
 *
 * Asked about records the server judged likely to be this person: the same
 * three names, or a typo apart on the same phone or mother. Answering «هو
 * نفسه» does not save — the right move is to open their file and add the
 * property there, and this dialog cannot do that for them without guessing
 * which card goes where. So it says so, and holds the save.
 *
 * ## Whose number is this?
 *
 * Asked when the phone typed here is also the phone of somebody this officer
 * registered in the last two hours, or the landlord's number on one of this
 * record's own cards. Both copied numbers found in production on 2026-09-16
 * were exactly that — an occupant's field holding the owner's number, typed
 * minutes after the owner's own record. A household line is a legitimate
 * answer and is one tap; «ليس رقمه» empties the field and marks it «غير مؤكَّد»
 * rather than keeping a number that would send the occupant's notices to the
 * landlord's handset.
 *
 * And for a household record, «رقم أحد أقاربه»: the father whose son's number
 * was typed into his file because he has no phone. Before it, the only honest
 * exit threw the number away and sent a finished record to «يتطلب مراجعة».
 *
 * ## When it does not ask
 *
 * A record the server is certain about (`certain`: the same three names, the
 * same mother written in full, and a phone, رقم السجل, residence permit or flat
 * of their own) is not a question. The officer is told the person is on file
 * and the save stays shut — «شخص آخر» is not offered, because on that evidence
 * it is the answer that makes the duplicate (user decision, 2026-09-29). An
 * administrator is still asked, with a reason, since a rule this strict needs
 * one way past it; the server enforces the same split.
 *
 * ## Why a reason
 *
 * A checkbox records that someone pressed it. One sentence — «أخوان، الأم
 * مختلفة» — is what a reviewer can check, and it goes into the audit row next
 * to the references of the records the officer was shown.
 */
export function DuplicateReviewDialog({
  findings,
  numbers,
  citizenHref,
  locale,
  canOverride = false,
  offerRelative = false,
  onCancel,
  onResolve,
}: {
  findings: DuplicateReviewFindings;
  /** SUPER_ADMIN: may file past a certain match as a different person, with a reason. */
  canOverride?: boolean;
  /**
   * A household record, where «رقم للتواصل» exists. A non-resident owner's
   * file keeps its own «جهة الاتصال المحلية» instead, so it is not offered there.
   */
  offerRelative?: boolean;
  /** The numbers as typed, for each question's wording. */
  numbers: Partial<Record<ContactNumberField, string | null>>;
  citizenHref: (id: string) => string;
  locale: string;
  onCancel: () => void;
  onResolve: (outcome: DuplicateReviewOutcome) => void;
}) {
  const t = useTranslations('duplicateReview');
  // The same words «سجلات مشابهة» uses beside a candidate — one source for what a match agreed on.
  const agreed = duplicateMatchedOnLabels(locale);
  const duplicates = findings.possibleDuplicates;
  const phoneOwners = findings.phoneOwners;
  const landlordCards = findings.landlordPhoneCards;
  const asksPerson = duplicates.length > 0;
  /** Certain matches an officer cannot answer «شخص آخر» to. */
  const certain = duplicates.filter((row) => row.certain);
  const stopped = certain.length > 0 && !canOverride;

  /** One question per number that matched somebody: the phone, a separate WhatsApp number, or both. */
  const matchedFields = useMemo(
    () =>
      FIELDS.filter(
        (field) =>
          phoneOwners.some((owner) => owner.fields.includes(field)) ||
          landlordCards.some((card) => card.field === field),
      ),
    [phoneOwners, landlordCards],
  );

  const [person, setPerson] = useState<PersonAnswer>(null);
  const [phoneAnswers, setPhoneAnswers] = useState<Partial<Record<ContactNumberField, PhoneAnswer>>>({});
  const [reason, setReason] = useState('');
  /** Answered once: a second click would resubmit the same filing. */
  const sentRef = useRef(false);
  const [sent, setSent] = useState(false);

  /*
    «رقم أحد أقاربه» on the phone answers the WhatsApp question too: a person
    with no phone has no WhatsApp number, so both of theirs are emptied and the
    second question is not asked.
  */
  const relative = offerRelative && phoneAnswers.phone === 'relative' && Boolean(numbers.phone);
  const askedFields = relative ? matchedFields.filter((field) => field === 'phone') : matchedFields;

  /** Who a number was found on, in one phrase, for its flag reason. */
  const holdersOf = (field: ContactNumberField) =>
    [
      ...phoneOwners.filter((owner) => owner.fields.includes(field)).map((owner) => owner.fullName),
      ...landlordCards
        .filter((card) => card.field === field)
        .map((card) => card.landlordName)
        .filter((name): name is string => Boolean(name)),
    ].filter((name, index, all) => all.indexOf(name) === index);

  const sharedFields = askedFields.filter((field) => phoneAnswers[field] === 'shared');
  const needsReason = person === 'different' || sharedFields.length > 0;
  // Filing past a certain match is an administrator's decision, and says why in full.
  const minReason = person === 'different' && certain.length > 0 ? 10 : MIN_REASON;
  const reasonOk = !needsReason || reason.trim().length >= minReason;
  const personOk = !asksPerson || person === 'different';
  const phonesOk = askedFields.every((field) => {
    const answer = phoneAnswers[field];
    return answer === 'shared' || answer === 'notTheirs' || (answer === 'relative' && relative);
  });
  const canSave = !stopped && personOk && phonesOk && reasonOk;
  const clearsAny = askedFields.some((field) => phoneAnswers[field] === 'notTheirs');

  const submit = () => {
    if (!canSave || sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    const answer: DuplicateReviewAnswer | undefined = needsReason
      ? {
          differentFrom: person === 'different' ? duplicates.map((row) => row.id) : [],
          // Anyone matched on a number the officer says is shared. A number they
          // clear is gone from the record, so the server has nothing to ask about it.
          sharedPhoneWith: phoneOwners
            .filter((owner) => owner.fields.some((field) => sharedFields.includes(field)))
            .map((owner) => owner.id),
          sharedPhoneWithLandlord: landlordCards.some((card) => sharedFields.includes(card.field)),
          reason: reason.trim(),
        }
      : undefined;

    const clear: DuplicateReviewOutcome['clear'] = {};
    for (const field of askedFields) {
      if (phoneAnswers[field] !== 'notTheirs') continue;
      const holder = holdersOf(field).join(t('listSeparator'));
      const what = field === 'phone' ? t('clearReason.phone') : t('clearReason.whatsapp');
      clear[field] = (holder ? t('clearReason.held', { what, holder }) : t('clearReason.unknown', { what })).slice(0, 300);
    }
    onResolve({ answer, clear, ...(relative ? { relative: numbers.phone! } : {}) });
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersRound className="size-5 shrink-0 text-warning" aria-hidden />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {stopped ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm leading-relaxed"
            >
              <Ban className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <span>
                <span className="block font-semibold">{t('stopped.title')}</span>
                {t('stopped.body')}
              </span>
            </p>
          ) : null}

          {asksPerson ? (
            <section className="space-y-2.5">
              <h3 className="text-sm font-semibold">{stopped ? t('person.onFile') : t('person.question')}</h3>
              <ul className="space-y-1.5">
                {duplicates.map((row) => (
                  <li
                    key={row.id}
                    className={cn(
                      'rounded-lg border p-2.5 text-xs',
                      row.certain ? 'border-destructive/40 bg-destructive/5' : 'bg-muted/30',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{row.fullName}</span>
                      {row.certain ? <Badge variant="soft-destructive">{t('person.samePerson')}</Badge> : null}
                      {row.referenceNumber ? (
                        <span dir="ltr" className="font-mono text-muted-foreground">
                          {row.referenceNumber}
                        </span>
                      ) : null}
                      <RecordKindBadge residence={row.residence} locale={locale} />
                      <Link
                        href={citizenHref(row.id)}
                        target="_blank"
                        rel="noopener"
                        className="ms-auto inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {t('person.openFile')}
                        <ExternalLink className="size-3" aria-hidden />
                      </Link>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                      {row.motherName ? <span>{t('person.mother', { name: row.motherName })}</span> : null}
                      {row.phone ? <span dir="ltr">{row.phone}</span> : null}
                      <span>{t('person.properties', { count: row.propertyCount })}</span>
                      {row.registeredBy ? <span>{t('person.filedBy', { name: row.registeredBy })}</span> : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-muted-foreground">{t('person.agreesOn')}</span>
                      {row.matchedOn.map((key) => (
                        <Badge key={key} variant="soft-warning" className="text-xs">
                          {agreed[key]}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>

              {stopped ? null : (
                <Choice
                  options={[
                    { value: 'same', label: t('person.yes') },
                    { value: 'different', label: certain.length > 0 ? t('person.noAdmin') : t('person.no') },
                  ]}
                  value={person}
                  onChange={(value) => setPerson(value as PersonAnswer)}
                />
              )}
              {person === 'same' ? (
                <p className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs leading-relaxed">
                  {t('person.openTheirs')}
                </p>
              ) : null}
            </section>
          ) : null}

          {askedFields.map((field) => (
            <section key={field} className="space-y-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <PhoneOff className="size-4 shrink-0 text-warning" aria-hidden />
                {field === 'phone' ? t('phone.questionPhone') : t('phone.questionWhatsapp')}
                {numbers[field] ? (
                  <span dir="ltr" className="font-mono text-xs font-normal text-muted-foreground">
                    {numbers[field]}
                  </span>
                ) : null}
              </h3>
              <ul className="space-y-1 text-xs">
                {phoneOwners
                  .filter((owner) => owner.fields.includes(field))
                  .map((owner) => (
                    <li key={owner.id} className="rounded-md bg-muted/30 px-2.5 py-1.5">
                      {t('phone.alsoOf', { name: owner.fullName, minutes: owner.minutesAgo })}
                    </li>
                  ))}
                {landlordCards
                  .filter((card) => card.field === field)
                  .map((card) => (
                    <li key={card.index} className="rounded-md bg-muted/30 px-2.5 py-1.5">
                      {card.landlordName
                        ? t('phone.alsoLandlordNamed', { index: card.index + 1, name: card.landlordName })
                        : t('phone.alsoLandlord', { index: card.index + 1 })}
                    </li>
                  ))}
              </ul>
              <Choice
                options={[
                  { value: 'shared', label: t('phone.shared') },
                  { value: 'notTheirs', label: t('phone.notTheirs') },
                  ...(offerRelative && field === 'phone' && numbers.phone
                    ? [{ value: 'relative', label: t('phone.relative') }]
                    : []),
                  { value: 'fix', label: t('phone.fix') },
                ]}
                value={phoneAnswers[field] ?? null}
                onChange={(value) =>
                  setPhoneAnswers((current) => ({ ...current, [field]: value as PhoneAnswer }))
                }
              />
              {field === 'phone' && relative ? (
                <p className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs leading-relaxed">
                  {t('phone.relativeNote')}
                </p>
              ) : null}
            </section>
          ))}

          {needsReason ? (
            <div className="space-y-1">
              <Label htmlFor="duplicate-review-reason">{t('reason.label')}</Label>
              <Textarea
                id="duplicate-review-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={300}
                className="min-h-[64px] text-sm"
                placeholder={t('reason.placeholder')}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} className="h-11 sm:h-10">
            {t('back')}
          </Button>
          <Button onClick={submit} disabled={!canSave || sent} className="h-11 sm:h-10">
            {clearsAny ? t('clearAndSave') : t('saveNew')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One question, answered by exactly one tap. */
function Choice({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div role="radiogroup" className="grid gap-1.5 sm:grid-cols-2">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-11 rounded-md border px-3 py-2 text-start text-xs font-medium transition-colors',
              active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
