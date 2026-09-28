'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, ClipboardCheck, ExternalLink, Info } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { CardChangeView, CitizenEditReview } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { Textarea } from '@/components/ui/textarea';

/** The high-impact fields whose values the trail never keeps — `SENSITIVE_FILE_FIELDS` on the server. */
const REASON_SENSITIVE = new Set(['civilRecordNumber', 'identityDocNumber', 'residencyNumber', 'residentStatus']);

/**
 * «مراجعة التعديلات» — what saving this edit will do, before it is pressed.
 *
 * The server's dry reading of the edit (`reviewCitizenEdit`): every field that
 * changes, from what to what; the cards added, removed or changed; what else
 * the save touches that the form cannot show; what would refuse it; and a
 * reason, required when the edit corrects a high-impact field (نوع الملف, صفة
 * الإقامة, an identity number that held a value, a card's owner/tenant
 * capacity or رقم العقار) and optional otherwise. The reason goes on the audit
 * row with the change.
 *
 * Sensitive values are named, not shown: the officer can see what they typed
 * in the form, and the review is what the audit keeps.
 */
export function EditReviewDialog({
  review,
  open,
  onCancel,
  onConfirm,
  initialReason,
  locale = 'ar',
}: {
  review: CitizenEditReview | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (changeReason: string | undefined) => void;
  /** What the officer already said — «تغيير الإقامة» asks it with the move. Still editable. */
  initialReason?: string;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const reasonId = useId();
  const params = useParams<{ tenant?: string; locale?: string; adminPath?: string }>();
  const base =
    params?.tenant && params?.locale && params?.adminPath
      ? `/${params.tenant}/${params.locale}/${params.adminPath}`
      : null;
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason(initialReason ?? '');
  }, [open, initialReason]);

  if (!review) return null;

  const fieldLabel = (field: string) =>
    (labels.citizenField as Record<string, string>)[field] ??
    (field === 'residence' ? (en ? 'File type' : 'نوع الملف') : field === 'notes' ? (en ? 'Notes' : 'الملاحظات') : field);

  const enums: Record<string, Record<string, string> | undefined> = {
    residence: labels.citizenResidence as Record<string, string>,
    maritalStatus: labels.maritalStatus as Record<string, string>,
    gender: labels.gender as Record<string, string>,
    bloodType: labels.bloodType as Record<string, string>,
    occupancyType: labels.occupancyType as Record<string, string>,
    propertyType: labels.propertyType as Record<string, string>,
    unitStatus: labels.unitStatus as Record<string, string>,
    unitType: labels.unitType as Record<string, string>,
    landType: labels.landType as Record<string, string>,
  };
  const show = (field: string, value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? (en ? 'Yes' : 'نعم') : en ? 'No' : 'لا';
    if (Array.isArray(value)) return value.length ? value.map((item) => show(field, item)).join('، ') : '—';
    const mapped = typeof value === 'string' ? enums[field]?.[value] : undefined;
    return mapped ?? String(value);
  };

  const { changes, impacts, blockers, reasonRequired } = review;
  const valued = Object.keys(changes.after).filter((field) => field in changes.before || field in changes.after);
  const unvalued = changes.changed.filter((field) => !valued.includes(field));
  const nothing = changes.changed.length === 0 && changes.cards.length === 0;
  const blocking = blockers.filter((row) => row.code === 'TENANTS_LINKED');
  const needsReason = reasonRequired.length > 0;
  /*
    Three characters either way — the server's floor (`changeReason`). An
    optional reason of one or two would pass here and be refused on save.
  */
  const reasonLength = reason.trim().length;
  const ready = blocking.length === 0 && (reasonLength === 0 ? !needsReason : reasonLength >= 3);
  /*
    An identity number or صفة الإقامة is corrected here and its values are never
    kept (`SENSITIVE_FILE_FIELDS`), so the reason must not be where they turn up
    again: it asks for what the correction rests on, not the numbers.
  */
  const correctsSensitive = reasonRequired.some((field) => REASON_SENSITIVE.has(field));

  const cardName = (card: CardChangeView) =>
    [
      card.propertyType ? show('propertyType', card.propertyType) : null,
      card.propertyNumber ? `${en ? 'parcel' : 'عقار'} ${card.propertyNumber}` : null,
      card.occupancyType ? show('occupancyType', card.occupancyType) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const row = (key: string, label: string, before: string, after: string) => (
    <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-muted-foreground line-through decoration-1">{before}</span>
        <span aria-hidden className="text-muted-foreground">←</span>
        <span className="font-medium text-foreground">{after}</span>
      </span>
    </li>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-lg" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <ClipboardCheck className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>{en ? 'Review the changes' : 'مراجعة التعديلات'}</DialogTitle>
              <DialogDescription>
                {en
                  ? 'This is what saving will change on the file. Nothing is saved until you confirm.'
                  : 'هذا ما سيتغيّر في الملف عند الحفظ. لا يُحفظ شيء قبل أن تؤكّد.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── What would refuse the save ── */}
          {blockers.map((blocker) => (
            <div
              key={blocker.code}
              role="alert"
              className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
            >
              <p className="flex items-start gap-2 font-medium text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {blocker.message}
              </p>
              {blocker.tenants && base ? (
                <ul className="space-y-1">
                  {blocker.tenants.map((tenant) => (
                    <li key={tenant.propertyEntryId}>
                      <Link
                        href={`${base}/citizens/${encodeURIComponent(tenant.citizenId)}`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {en ? `Open ${tenant.name}’s file` : `افتح ملف ${tenant.name}`}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}

          {/* ── What changes ── */}
          {nothing ? (
            <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              {en ? 'No field on the file changes.' : 'لا يتغيّر أي حقل في الملف.'}
            </p>
          ) : (
            <div className="rounded-md border px-3 py-1">
              <ul className="divide-y">
                {valued.map((field) =>
                  row(field, fieldLabel(field), show(field, changes.before[field]), show(field, changes.after[field])),
                )}
                {unvalued.map((field) => (
                  <li key={field} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <span className="text-muted-foreground">{fieldLabel(field)}</span>
                    <span className="font-medium">
                      {en ? 'Changed — value not shown' : 'عُدِّل — القيمة لا تُعرض'}
                    </span>
                  </li>
                ))}
                {changes.cards.map((card) =>
                  card.kind === 'changed' ? (
                    [
                      ...(card.fields ?? []).map((field) =>
                        row(
                          `${card.cardId}:${field.field}`,
                          `${en ? 'Card' : 'بطاقة'} ${cardName(card)} — ${fieldLabel(field.field)}`,
                          show(field.field, field.before),
                          show(field.field, field.after),
                        ),
                      ),
                      ...(card.sensitive ?? []).map((field) => (
                        <li key={`${card.cardId}:${field}`} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                          <span className="text-muted-foreground">
                            {en ? 'Card' : 'بطاقة'} {cardName(card)} — {fieldLabel(field)}
                          </span>
                          <span className="font-medium">{en ? 'Changed' : 'عُدِّل'}</span>
                        </li>
                      )),
                      ...(card.rows
                        ? [
                            <li key={`${card.cardId}:rows`} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                              <span className="text-muted-foreground">
                                {en ? 'Card' : 'بطاقة'} {cardName(card)} — {en ? 'units' : 'الوحدات'}
                              </span>
                              <span className="font-medium">
                                {[
                                  card.rows.added ? (en ? `${card.rows.added} added` : `تُضاف ${card.rows.added}`) : null,
                                  card.rows.removed ? (en ? `${card.rows.removed} removed` : `تُحذف ${card.rows.removed}`) : null,
                                  card.rows.changed ? (en ? `${card.rows.changed} changed` : `تُعدَّل ${card.rows.changed}`) : null,
                                ]
                                  .filter(Boolean)
                                  .join('، ')}
                              </span>
                            </li>,
                          ]
                        : []),
                    ]
                  ) : (
                    <li key={card.cardId} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                      <span className="text-muted-foreground">{cardName(card)}</span>
                      <span className={card.kind === 'removed' ? 'font-medium text-destructive' : 'font-medium text-success'}>
                        {card.kind === 'removed' ? (en ? 'Card removed' : 'تُحذف البطاقة') : en ? 'Card added' : 'تُضاف بطاقة'}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}

          {/* ── What else it touches ── */}
          {impacts.loginChanges || impacts.tenantsShowingName.length > 0 || impacts.openBills || impacts.cardsRemoved > 0 ? (
            <div className="rounded-md bg-muted/40 p-3">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{en ? 'Also affected' : 'ما يتأثّر أيضاً'}</p>
              <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed">
                {impacts.loginChanges ? (
                  <li>
                    {en
                      ? 'The phone number changes, and with it the citizen’s login (reference number + phone).'
                      : 'يتغيّر رقم الهاتف، ومعه دخول المواطن إلى حسابه (الرقم المرجعي + الهاتف).'}
                  </li>
                ) : null}
                {impacts.tenantsShowingName.length > 0 ? (
                  <li>
                    {en
                      ? `Shown as the landlord on ${impacts.tenantsShowingName.length} tenant file(s): ${impacts.tenantsShowingName.map((row) => row.name).join(', ')}.`
                      : `يظهر مالكاً في ${impacts.tenantsShowingName.length} ملف مستأجر: ${impacts.tenantsShowingName.map((row) => row.name).join('، ')}.`}
                  </li>
                ) : null}
                {impacts.cardsRemoved > 0 ? (
                  <li>
                    {en
                      ? `${impacts.cardsRemoved} card(s) leave the file as entered by mistake; their units drop out of the file’s history.`
                      : `تخرج ${impacts.cardsRemoved} بطاقة من الملف كإدخال خاطئ، وتخرج وحداتها من سجلّه.`}
                  </li>
                ) : null}
                {impacts.openBills ? (
                  <li>
                    {en ? `${impacts.openBills.count} open bill(s), ` : `${impacts.openBills.count} فاتورة غير مسدَّدة، المستحق `}
                    <Money amount={impacts.openBills.outstanding} locale={locale} />
                    {en
                      ? ' — calculated before this correction. They are not changed; if their basis changes they appear on the accountant’s list of bills affected by corrections.'
                      : ' — احتُسبت قبل هذا التصحيح. لا تتغيّر؛ وإن تغيّر أساس احتسابها تظهر في قائمة المحاسب «فواتير تأثّرت بتصحيحات».'}
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {/* ── Why ── */}
          <Field
            label={en ? 'Reason for the change' : 'سبب التعديل'}
            htmlFor={reasonId}
            required={needsReason}
          >
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={500}
              aria-describedby={`${reasonId}-help`}
            />
            <p id={`${reasonId}-help`} className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {needsReason
                ? en
                  ? `Required: this corrects ${reasonRequired.map(fieldLabel).join(', ')}. Kept in the file’s history under your name.${correctsSensitive ? ' Say what the correction rests on (the document you saw), not the numbers themselves — they are not kept.' : ''}`
                  : `مطلوب: هذا يصحّح ${reasonRequired.map(fieldLabel).join('، ')}. يُحفظ في سجل تعديلات الملف باسمك.${correctsSensitive ? ' اذكر ما يستند إليه التصحيح (المستند الذي اطّلعت عليه)، لا الأرقام نفسها — فهي لا تُحفظ.' : ''}`
                : en
                  ? 'Optional. Kept in the file’s history under your name.'
                  : 'اختياري. يُحفظ في سجل تعديلات الملف باسمك.'}
            </p>
          </Field>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel} className="h-11 w-full sm:h-10 sm:w-auto">
            {en ? 'Back to the form' : 'العودة إلى النموذج'}
          </Button>
          <Button
            onClick={() => onConfirm(reason.trim() || undefined)}
            disabled={!ready}
            className="h-11 w-full transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none sm:h-10 sm:w-auto"
          >
            <ClipboardCheck className="size-4" aria-hidden />
            {en ? 'Confirm and save' : 'تأكيد وحفظ'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
