'use client';

import { useId } from 'react';
import { getLabels, VACANCY_BASIS } from '@mechanization/shared-schemas';
import type { VacancyBasis } from '@mechanization/shared-schemas';
import type { AfterTenancyAnswer, AfterTenancyStatus, EndTenancyResult } from '@/lib/api-client';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * «ما حال الوحدة الآن؟» — asked in the same step that ends a tenancy.
 *
 * Not left to a default, because the default was the bug: a flat still reading
 * «مؤجرة» after its tenant left charged the occupancy fee to nobody. Each answer
 * says, in the line under it, what it does to the bill — the officer should not
 * have to know that «شاغرة» exempts the owner to choose it knowingly.
 *
 * Shared by the unit matrix's «إنهاء الإشغال» and the file's «إنهاء الإيجار»,
 * so the question reads the same through either door.
 */
export function AfterTenancyQuestion({
  value,
  onChange,
  ownerNonResident = false,
  locale,
}: {
  value: AfterTenancyAnswer;
  onChange: (next: AfterTenancyAnswer) => void;
  /** The owner lives elsewhere — they cannot be recorded living in a dwelling. */
  ownerNonResident?: boolean;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const group = useId();
  const basisGroup = useId();
  const notesId = useId();

  const options: Array<{ status: AfterTenancyStatus; title: string; effect: string; disabled?: string }> = [
    {
      status: 'OWNER_OCCUPIED',
      title: en ? 'The owner lives there' : 'يسكنها المالك',
      effect: en ? 'The owner is charged the occupancy fee.' : 'يتحمّل المالك رسم الإشغال.',
      disabled: ownerNonResident
        ? en
          ? 'The owner lives elsewhere.'
          : 'المالك غير مقيم في البلدة.'
        : undefined,
    },
    {
      status: 'VACANT',
      title: en ? 'Empty' : 'شاغرة',
      effect: en
        ? 'Recorded as a confirmed vacancy, which exempts the owner. Say what it rests on.'
        : 'تُسجَّل «تأكيد شغور» فيُعفى المالك — حدّد على ماذا يستند.',
    },
    {
      status: 'RENTED_TO_OTHER',
      title: en ? 'Rented to someone else' : 'مؤجرة لمستأجر آخر',
      effect: en
        ? 'Stays «rented», and a case is opened to register the new tenant.'
        : 'تبقى «مؤجرة» وتُفتح حالة لتسجيل المستأجر الجديد.',
    },
    {
      status: 'UNKNOWN',
      title: en ? 'I don’t know' : 'لا أعرف',
      effect: en
        ? 'The status is cleared — the owner is billed until it is confirmed — and a case is opened to check.'
        : 'تُمسح حالة الوحدة — ويُحتسب الرسم على المالك حتى تُعرف — وتُفتح حالة للتحقق.',
    },
  ];

  const needsSource = value.afterStatus === 'VACANT' && value.vacancyBasis === 'NEIGHBOUR_OR_CARETAKER';

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">
        {en ? 'What is the unit now?' : 'ما حال الوحدة الآن؟'} <span className="text-destructive">*</span>
      </legend>

      <div role="radiogroup" className="grid gap-2">
        {options.map((option) => {
          const selected = value.afterStatus === option.status;
          return (
            <label
              key={option.status}
              className={cn(
                'flex min-h-11 items-start gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors duration-150',
                option.disabled
                  ? 'cursor-not-allowed opacity-60'
                  : selected
                    ? 'cursor-pointer border-primary bg-primary/10'
                    : 'cursor-pointer hover:bg-accent',
              )}
            >
              <input
                type="radio"
                name={group}
                checked={selected}
                disabled={Boolean(option.disabled)}
                onChange={() =>
                  onChange({
                    afterStatus: option.status,
                    ...(option.status === 'VACANT'
                      ? { vacancyBasis: value.vacancyBasis, vacancyNotes: value.vacancyNotes }
                      : {}),
                  })
                }
                className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
              />
              <span className="min-w-0 space-y-0.5">
                <span className={cn('block font-medium', selected && 'text-primary')}>{option.title}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  {option.disabled ?? option.effect}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {value.afterStatus === 'VACANT' ? (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          <p className="text-xs font-medium">
            {en ? 'The vacancy rests on' : 'يستند الشغور إلى'} <span className="text-destructive">*</span>
          </p>
          <div role="radiogroup" className="grid gap-1.5">
            {VACANCY_BASIS.map((basis) => (
              <label key={basis} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name={basisGroup}
                  checked={value.vacancyBasis === basis}
                  onChange={() => onChange({ ...value, vacancyBasis: basis as VacancyBasis })}
                  className="size-4 shrink-0 accent-[hsl(var(--primary))]"
                />
                {labels.vacancyBasis[basis as VacancyBasis]}
              </label>
            ))}
          </div>
          <label htmlFor={notesId} className="block pt-1 text-xs font-medium">
            {needsSource
              ? en
                ? 'Who said so?'
                : 'من أفاد بذلك؟'
              : en
                ? 'Notes (optional)'
                : 'ملاحظات (اختياري)'}
            {needsSource ? <span className="text-destructive"> *</span> : null}
          </label>
          <Textarea
            id={notesId}
            value={value.vacancyNotes ?? ''}
            onChange={(event) => onChange({ ...value, vacancyNotes: event.target.value })}
            className="min-h-[64px] text-sm"
            maxLength={1000}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/** Whether the answer is complete enough to send. */
export function afterTenancyComplete(answer: AfterTenancyAnswer): boolean {
  if (!answer.afterStatus) return false;
  if (answer.afterStatus !== 'VACANT') return true;
  if (!answer.vacancyBasis) return false;
  return answer.vacancyBasis !== 'NEIGHBOUR_OR_CARETAKER' || Boolean(answer.vacancyNotes?.trim());
}

/**
 * The toast after an ending — says what happened to the card and to the flat,
 * because both halves land somewhere the officer is not looking.
 */
export function endTenancyMessage(
  result: EndTenancyResult | { ownerSpellEnded: true },
  locale: string,
): string {
  const en = locale === 'en';
  if ('ownerSpellEnded' in result) {
    return en
      ? 'Ownership ended, and the property released from their file'
      : 'تم إنهاء الملكية وفصل العقار عن ملف المواطن';
  }
  const head =
    result.cardsEnded > 0
      ? en
        ? 'Tenancy ended — the card stays on their file as ended'
        : 'انتهى الإيجار — بقيت البطاقة في ملفه كإيجار منتهٍ'
      : en
        ? 'Tenancy ended on this unit'
        : 'انتهى الإيجار على هذه الوحدة';
  const tail: Record<AfterTenancyStatus, [string, string]> = {
    OWNER_OCCUPIED: ['the owner is recorded living there', 'وسُجِّل أن المالك يسكنها'],
    VACANT: ['the vacancy is confirmed', 'وسُجِّل تأكيد الشغور'],
    RENTED_TO_OTHER: ['a case was opened to register the new tenant', 'وفُتحت حالة لتسجيل المستأجر الجديد'],
    UNKNOWN: ['a case was opened to check the unit', 'وفُتحت حالة للتحقق من حال الوحدة'],
  };
  if (!result.statusApplied) return head;
  const [enTail, arTail] = tail[result.statusApplied];
  return en ? `${head}; ${enTail}` : `${head}، ${arTail}`;
}

/** Only the fields that belong to the chosen answer. */
export function afterTenancyPayload(answer: AfterTenancyAnswer): AfterTenancyAnswer {
  if (!answer.afterStatus) return {};
  return answer.afterStatus === 'VACANT'
    ? {
        afterStatus: 'VACANT',
        vacancyBasis: answer.vacancyBasis,
        ...(answer.vacancyNotes?.trim() ? { vacancyNotes: answer.vacancyNotes.trim() } : {}),
      }
    : { afterStatus: answer.afterStatus };
}
