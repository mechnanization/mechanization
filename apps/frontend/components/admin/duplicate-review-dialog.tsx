'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, PhoneOff, UsersRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type {
  ContactNumberField,
  DuplicateReviewAnswer,
  DuplicateReviewFindings,
} from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
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

/** «٤ دقائق», «دقيقة واحدة», «١١ دقيقة» — the count agrees with its noun. */
function minutesAr(count: number): string {
  if (count === 1) return 'دقيقة واحدة';
  if (count === 2) return 'دقيقتين';
  if (count >= 3 && count <= 10) return `${count} دقائق`;
  return `${count} دقيقة`;
}

/**
 * Save as a new record, with the officer's answer attached — and, for any
 * number that is not this person's, the field to empty and the «غير مؤكَّد»
 * reason to flag it with. The phone and a separate WhatsApp number are cleared
 * independently: only the one that was somebody else's goes.
 */
export interface DuplicateReviewOutcome {
  answer: DuplicateReviewAnswer | undefined;
  clear: Partial<Record<ContactNumberField, string>>;
}

type PersonAnswer = 'same' | 'different' | null;
type PhoneAnswer = 'shared' | 'notTheirs' | 'fix';

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
  onCancel,
  onResolve,
}: {
  findings: DuplicateReviewFindings;
  /** The numbers as typed, for each question's wording. */
  numbers: Partial<Record<ContactNumberField, string | null>>;
  citizenHref: (id: string) => string;
  locale: string;
  onCancel: () => void;
  onResolve: (outcome: DuplicateReviewOutcome) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const duplicates = findings.possibleDuplicates;
  const phoneOwners = findings.phoneOwners;
  const landlordCards = findings.landlordPhoneCards;
  const asksPerson = duplicates.length > 0;

  /** One question per number that matched somebody: the phone, a separate WhatsApp number, or both. */
  const askedFields = useMemo(
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
  const reasonOk = !needsReason || reason.trim().length >= MIN_REASON;
  const personOk = !asksPerson || person === 'different';
  const phonesOk = askedFields.every(
    (field) => phoneAnswers[field] === 'shared' || phoneAnswers[field] === 'notTheirs',
  );
  const canSave = personOk && phonesOk && reasonOk;
  const clearsAny = askedFields.some((field) => phoneAnswers[field] === 'notTheirs');

  const submit = () => {
    if (!canSave) return;
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
      const holder = holdersOf(field).join(en ? ', ' : '، ');
      const what = field === 'phone' ? (en ? 'number' : 'رقم الهاتف') : en ? 'WhatsApp number' : 'رقم الواتساب';
      clear[field] = (
        holder
          ? en
            ? `The ${what} entered belonged to ${holder} — cleared until the right one is known`
            : `${what} المُدخل كان رقم ${holder} — أُفرغ بانتظار الرقم الصحيح`
          : en
            ? `The ${what} entered belonged to someone else — cleared until the right one is known`
            : `${what} المُدخل كان لشخص آخر — أُفرغ بانتظار الرقم الصحيح`
      ).slice(0, 300);
    }
    onResolve({ answer, clear });
  };

  const matchLabel = (key: DuplicateReviewFindings['possibleDuplicates'][number]['matchedOn'][number]) =>
    ({
      NAME: en ? 'same name' : 'الاسم نفسه',
      NAME_SIMILAR: en ? 'similar name' : 'اسم مشابه',
      PHONE: en ? 'same phone' : 'الهاتف نفسه',
      MOTHER: en ? "same mother's name" : 'اسم الأم نفسه',
    })[key];

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersRound className="size-5 shrink-0 text-warning" aria-hidden />
            {en ? 'Before saving' : 'قبل الحفظ'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? 'Nothing has been saved yet. Answer what is below, or go back to the form.'
              : 'لم يُحفظ شيء بعد. أجب عمّا يلي، أو ارجع إلى النموذج.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {asksPerson ? (
            <section className="space-y-2.5">
              <h3 className="text-sm font-semibold">
                {en ? 'Is this person already registered?' : 'هل هذا الشخص مسجَّل مسبقاً؟'}
              </h3>
              <ul className="space-y-1.5">
                {duplicates.map((row) => (
                  <li key={row.id} className="rounded-lg border bg-muted/30 p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{row.fullName}</span>
                      {row.referenceNumber ? (
                        <span dir="ltr" className="font-mono text-muted-foreground">
                          {row.referenceNumber}
                        </span>
                      ) : null}
                      {row.residence === 'NON_RESIDENT_OWNER' ? (
                        <Badge variant="soft-info">{labels.citizenResidence.NON_RESIDENT_OWNER}</Badge>
                      ) : null}
                      <Link
                        href={citizenHref(row.id)}
                        target="_blank"
                        rel="noopener"
                        className="ms-auto inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {en ? 'Open file' : 'فتح ملفه'}
                        <ExternalLink className="size-3" aria-hidden />
                      </Link>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                      {row.motherName ? (
                        <span>{en ? `mother: ${row.motherName}` : `والدته: ${row.motherName}`}</span>
                      ) : null}
                      {row.phone ? <span dir="ltr">{row.phone}</span> : null}
                      <span>
                        {en ? `${row.propertyCount} propert${row.propertyCount === 1 ? 'y' : 'ies'}` : `${row.propertyCount} عقار`}
                      </span>
                      {row.registeredBy ? (
                        <span>{en ? `filed by ${row.registeredBy}` : `سجَّله ${row.registeredBy}`}</span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {row.matchedOn.map((key) => (
                        <Badge key={key} variant="soft-warning" className="text-[10px]">
                          {matchLabel(key)}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>

              <Choice
                options={[
                  {
                    value: 'same',
                    label: en ? 'Yes — it is the same person' : 'نعم — هو الشخص نفسه',
                  },
                  {
                    value: 'different',
                    label: en ? 'No — a different person' : 'لا — شخص مختلف',
                  },
                ]}
                value={person}
                onChange={(value) => setPerson(value as PersonAnswer)}
              />
              {person === 'same' ? (
                <p className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs leading-relaxed">
                  {en
                    ? 'Do not create a second file. Open theirs, press edit, and add this property to it. Your form stays here if you need to copy from it.'
                    : 'لا تُنشئ ملفاً ثانياً. افتح ملفه، واضغط تعديل، وأضف هذا العقار إليه. يبقى نموذجك هنا إن احتجت النسخ منه.'}
                </p>
              ) : null}
            </section>
          ) : null}

          {askedFields.map((field) => (
            <section key={field} className="space-y-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <PhoneOff className="size-4 shrink-0 text-warning" aria-hidden />
                {field === 'phone'
                  ? en
                    ? 'Whose phone number is this?'
                    : 'لمن رقم الهاتف هذا؟'
                  : en
                    ? 'Whose WhatsApp number is this?'
                    : 'لمن رقم الواتساب هذا؟'}
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
                      {en
                        ? `It is also the number of ${owner.fullName}, whom you registered ${owner.minutesAgo} min ago.`
                        : `هو أيضاً رقم ${owner.fullName}، الذي سجَّلتَه قبل ${minutesAr(owner.minutesAgo)}.`}
                    </li>
                  ))}
                {landlordCards
                  .filter((card) => card.field === field)
                  .map((card) => (
                    <li key={card.index} className="rounded-md bg-muted/30 px-2.5 py-1.5">
                      {en
                        ? `It is also the landlord's number on property ${card.index + 1}${card.landlordName ? ` (${card.landlordName})` : ''}.`
                        : `وهو أيضاً رقم صاحب الملك على العقار ${card.index + 1}${card.landlordName ? ` (${card.landlordName})` : ''}.`}
                    </li>
                  ))}
              </ul>
              <Choice
                options={[
                  {
                    value: 'shared',
                    label: en ? 'They share this line (family phone)' : 'رقم مشترك بينهم (هاتف العائلة)',
                  },
                  {
                    value: 'notTheirs',
                    label: en
                      ? 'Not this person’s number — clear it and mark it unverified'
                      : 'ليس رقمه — أفرغ الحقل وعلِّمه «غير مؤكَّد»',
                  },
                  {
                    value: 'fix',
                    label: en ? 'I will correct the number' : 'سأصحّح الرقم',
                  },
                ]}
                value={phoneAnswers[field] ?? null}
                onChange={(value) =>
                  setPhoneAnswers((current) => ({ ...current, [field]: value as PhoneAnswer }))
                }
              />
            </section>
          ))}

          {needsReason ? (
            <div className="space-y-1">
              <Label htmlFor="duplicate-review-reason">
                {en ? 'In one sentence, how do you know?' : 'بجملة واحدة، كيف عرفت ذلك؟'}
              </Label>
              <Textarea
                id="duplicate-review-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={300}
                className="min-h-[64px] text-sm"
                placeholder={en ? 'e.g. brothers — different first names, same mother' : 'مثال: أخوان — الاسم الأول مختلف والأم نفسها'}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            className="h-11 sm:h-10"
          >
            {en ? 'Back to the form' : 'رجوع إلى النموذج'}
          </Button>
          <Button
            onClick={submit}
            disabled={!canSave}
            className="h-11 sm:h-10"
          >
            {clearsAny
              ? en
                ? 'Clear the number and save'
                : 'إفراغ الرقم والحفظ'
              : en
                ? 'Save as a new record'
                : 'حفظ كملف جديد'}
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
