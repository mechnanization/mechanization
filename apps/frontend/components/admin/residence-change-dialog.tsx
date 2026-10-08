'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Home, Info, Loader2, MoveRight, UserX } from 'lucide-react';
import { getLabels, isOwnerRecord, type CitizenResidence, type UnitStatus } from '@mechanization/shared-schemas';
import type { CitizenFormValues } from '@/components/admin/citizen-form';
import { EndTenancyDialog } from '@/components/admin/end-tenancy-dialog';
import { ApiRequestError, logApiError, setCitizenActive, type EndTenancyResult } from '@/lib/api-client';
import {
  homeStatusesFor,
  planResidenceMove,
  type MoveHome,
  type ResidenceMoveAnswers,
} from '@/lib/residence-move';
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
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const today = () => new Date().toISOString().slice(0, 10);
const ELSEWHERE = 'elsewhere';

/**
 * «تغيير الإقامة» — a real move into or out of the town, settled on the form.
 *
 * Opened when an officer changes «هل يقيم في البلدة؟» on a saved file. It reads
 * what the move has to settle from the form (`planResidenceMove`) and asks only
 * that: the day, the tenancies that end with it, what each home the person
 * owned and lived in is now, and where they live — or, moving back, which of
 * their homes they live in. Tenancies end for real, on their day, through the
 * card's own «إنهاء الإيجار»; everything else is written into the form, which
 * is saved and reviewed as ever.
 *
 * A residence recorded wrongly is not a move: «تصحيح دون انتقال» only switches
 * the answer, and the form and the save's reason do the rest.
 *
 * A death opens it too, toward «تركة» (0076): the same settling with the date
 * of death — every tenancy ends, a home he lived in becomes whoever lives there
 * now, a file left owning nothing is archived — and no «where do they live».
 */
export function ResidenceChangeDialog({
  open,
  to,
  values,
  tenant,
  token,
  citizenId,
  locale = 'ar',
  onCancel,
  onApply,
  onCorrect,
  onTenancyEnded,
  onRemoveUnsaved,
  onDeactivated,
}: {
  open: boolean;
  to: CitizenResidence;
  values: CitizenFormValues;
  tenant: string;
  token: string | null | undefined;
  citizenId: string;
  locale?: string;
  onCancel: () => void;
  onApply: (answers: ResidenceMoveAnswers) => void;
  /** Switch the answer only — the residence was recorded wrongly. */
  onCorrect: () => void;
  onTenancyEnded: (cardIndex: number, result: EndTenancyResult, cardEnded: boolean) => void;
  /** A card never saved: it leaves the form, nothing to end. */
  onRemoveUnsaved: (cardIndex: number) => void;
  onDeactivated: () => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const ids = { date: useId(), place: useId(), reason: useId(), requestedBy: useId() };
  const tArchive = useTranslations('citizenArchive');
  const tKind = useTranslations('citizenKind');
  /** Out of the household: a move away, or a death. */
  const leaving = isOwnerRecord(to);
  const death = to === 'ESTATE';
  const plan = useMemo(() => planResidenceMove(values, to), [values, to]);

  const [movedOn, setMovedOn] = useState(today());
  const [place, setPlace] = useState('');
  const [statuses, setStatuses] = useState<Record<string, UnitStatus>>({});
  const [livesIn, setLivesIn] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [ending, setEnding] = useState<number | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  /** «بطلب من» — who asked for the file to be archived; required with the reason (decision, 2026-10-05). */
  const [requestedBy, setRequestedBy] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMovedOn(today());
    setPlace(typeof values.personal.residencePlace === 'string' ? values.personal.residencePlace : '');
    setStatuses({});
    setLivesIn(null);
    setReason('');
    setReasonTouched(false);
    setRequestedBy('');
    setEnding(null);
    setFailure(null);
    // Only on opening: the form below changes as tenancies end, and the answers must survive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Until the officer writes their own, the reason says what the dialog knows.
  const suggested = death
    ? tKind('death.suggestedReason')
    : leaving
    ? en
      ? `Moved to live outside the town${place.trim() ? ` (${place.trim()})` : ''}`
      : `انتقل للسكن خارج البلدة${place.trim() ? ` (${place.trim()})` : ''}`
    : en
      ? 'Came back to live in the town'
      : 'عاد للسكن في البلدة';
  const reasonText = reasonTouched ? reason : suggested;

  const homeLabel = (home: MoveHome) => {
    const what = home.unitType
      ? ((labels.unitType as Record<string, string>)[home.unitType] ?? home.unitType)
      : ((labels.propertyType as Record<string, string>)[home.propertyType ?? ''] ?? (en ? 'Property' : 'عقار'));
    const floor = home.floor ? (en ? `, floor ${home.floor}` : `، الطابق ${home.floor}`) : '';
    const where = home.propertyNumber ? (en ? ` on parcel ${home.propertyNumber}` : ` على العقار ${home.propertyNumber}`) : '';
    return `${what}${floor}${where}`;
  };
  const cardLabel = (entry: { propertyNumber: string | null; propertyType?: string | null }) =>
    `${(labels.propertyType as Record<string, string>)[entry.propertyType ?? ''] ?? (en ? 'Property' : 'عقار')}${
      entry.propertyNumber ? (en ? ` on parcel ${entry.propertyNumber}` : ` على العقار ${entry.propertyNumber}`) : ''
    }`;

  const reasonOk = reasonText.trim().length >= 3;
  const ready = leaving
    ? plan.tenancies.length === 0 &&
      plan.needsUnitType.length === 0 &&
      !plan.nothingLeft &&
      plan.homes.every((home) => statuses[home.key]) &&
      (death || place.trim().length >= 2) &&
      Boolean(movedOn) &&
      reasonOk
    : livesIn !== null && Boolean(movedOn) && reasonOk;

  const deactivate = async () => {
    if (!token) return;
    setDeactivating(true);
    setFailure(null);
    try {
      // Why the file stopped being billed, and from when — on the audit row.
      await setCitizenActive(tenant, token, citizenId, false, {
        reason: reasonText.trim(),
        requestedBy: requestedBy.trim(),
        movedOn,
      });
      onDeactivated();
    } catch (caught) {
      logApiError(caught);
      setFailure(caught instanceof ApiRequestError ? caught.message : tArchive('failed'));
    } finally {
      setDeactivating(false);
    }
  };

  const endingCard = ending === null ? null : values.properties[ending];

  return (
    <>
      <Dialog open={open && ending === null} onOpenChange={(value) => (value || deactivating ? undefined : onCancel())}>
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto" closeLabel={en ? 'Close' : 'إغلاق'}>
          <DialogHeader>
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <MoveRight className="size-5 rtl:rotate-180" />
              </span>
              <div className="min-w-0 space-y-1.5 text-start">
                <DialogTitle>
                  {death
                    ? tKind('death.title')
                    : leaving
                      ? en ? 'Moved to live outside the town' : 'انتقل للسكن خارج البلدة'
                      : en ? 'Came to live in the town' : 'أصبح يقيم في البلدة'}
                </DialogTitle>
                <DialogDescription>
                  {death
                    ? tKind('death.description')
                    : en
                      ? 'For a real move. If the residence was simply recorded wrongly, use «Correct without a move».'
                      : 'لانتقال فعلي. إن كان نوع الملف سُجِّل خطأً فاختر «تصحيح دون انتقال».'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            <Field label={death ? tKind('death.date') : en ? 'Moved on' : 'تاريخ الانتقال'} htmlFor={ids.date} required>
              <Input
                id={ids.date}
                type="date"
                value={movedOn}
                max={today()}
                onChange={(event) => setMovedOn(event.target.value)}
                className="h-10"
              />
            </Field>

            {/* ── Moving out: tenancies that end with the move ── */}
            {leaving && plan.tenancies.length > 0 ? (
              <section className="space-y-2 rounded-lg border p-3">
                <h3 className="text-sm font-semibold">
                  {death ? tKind('death.tenancies') : en ? 'Rentals that end with the move' : 'إيجارات تنتهي مع الانتقال'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {death
                    ? tKind('death.tenanciesBody')
                    : en
                      ? 'Somewhere people live cannot stay on a non-resident record. Each is ended on its day and kept in the history.'
                      : 'المسكن المستأجَر لا يبقى على ملف غير مقيم. يُنهى كلٌّ منها بتاريخه ويبقى في السجل.'}
                </p>
                <ul className="space-y-2">
                  {plan.tenancies.map((tenancy) => (
                    <li key={tenancy.cardIndex} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>{cardLabel(tenancy)}</span>
                      {tenancy.cardId ? (
                        <Button size="sm" variant="outline" disabled={!token} onClick={() => setEnding(tenancy.cardIndex)}>
                          {en ? 'End the rental' : 'إنهاء الإيجار'}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => onRemoveUnsaved(tenancy.cardIndex)}>
                          {en ? 'Remove from the form (never saved)' : 'حذف من النموذج (لم يُحفظ)'}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {leaving && plan.needsUnitType.length > 0 ? (
              <p role="alert" className="flex items-start gap-1.5 rounded-md bg-warning/10 p-3 text-sm text-foreground">
                <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {en
                  ? `Say what is rented on ${plan.needsUnitType.map(cardLabel).join(', ')} (its unit type) in the form first — a non-resident may rent only what nobody lives in.`
                  : `حدِّد نوع الوحدة المستأجَرة في ${plan.needsUnitType.map(cardLabel).join('، ')} في النموذج أولاً — غير المقيم يستأجر ما لا يُسكن فقط.`}
              </p>
            ) : null}

            {/* ── Moving out with nothing left: archive — never delete (decision, 2026-10-05) ── */}
            {leaving && plan.nothingLeft ? (
              <section className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <UserX className="size-4" aria-hidden />
                  {tArchive('nothingLeft.title')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {death ? tKind('death.nothingLeft') : tArchive('nothingLeft.body')}
                </p>
                <Field label={tArchive('requestedBy')} htmlFor={ids.requestedBy} required>
                  <Input
                    id={ids.requestedBy}
                    value={requestedBy}
                    maxLength={200}
                    placeholder={tArchive('requestedByPlaceholder')}
                    onChange={(event) => setRequestedBy(event.target.value)}
                    className="h-10"
                  />
                </Field>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    plan.tenancies.length > 0 ||
                    !movedOn ||
                    !reasonOk ||
                    requestedBy.trim().length < 2 ||
                    deactivating ||
                    !token
                  }
                  onClick={() => void deactivate()}
                >
                  {deactivating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserX className="size-4" aria-hidden />}
                  {plan.tenancies.length > 0 ? tArchive('nothingLeft.endRentalsFirst') : tArchive('confirm')}
                </Button>
              </section>
            ) : null}

            {/* ── Moving out: homes they owned and lived in ── */}
            {leaving && plan.homes.length > 0 ? (
              <section className="space-y-2 rounded-lg border p-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Home className="size-4" aria-hidden />
                  {death ? tKind('death.homes') : en ? 'Homes they owned and lived in' : 'منازل يملكها وكان يسكنها'}
                </h3>
                <ul className="space-y-2.5">
                  {plan.homes.map((home) => (
                    <li key={home.key} className="space-y-1">
                      <p className="text-sm">{homeLabel(home)}</p>
                      <Select
                        value={statuses[home.key] ?? ''}
                        onValueChange={(value) => setStatuses((current) => ({ ...current, [home.key]: value as UnitStatus }))}
                      >
                        <SelectTrigger className="h-10" aria-label={en ? `Now: ${homeLabel(home)}` : `حالته الآن: ${homeLabel(home)}`}>
                          <SelectValue placeholder={en ? 'What is it now?' : 'ما حاله الآن؟'} />
                        </SelectTrigger>
                        <SelectContent>
                          {homeStatusesFor(to).map((status) => (
                            <SelectItem key={status} value={status}>
                              {labels.unitStatus[status]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {death
                    ? tKind('death.homesHint')
                    : en
                      ? 'Rented or lent to someone: record that person on their own file too.'
                      : 'مؤجَّر أو مُعار لأحد: يُسجَّل ذلك الشخص في ملفه أيضاً.'}
                </p>
              </section>
            ) : null}

            {leaving && !death && !plan.nothingLeft ? (
              <Field label={en ? 'Where do they live now?' : 'أين يقيم الآن؟'} htmlFor={ids.place} required>
                <Input
                  id={ids.place}
                  value={place}
                  maxLength={80}
                  placeholder={en ? 'Town or country' : 'مدينة أو بلد'}
                  onChange={(event) => setPlace(event.target.value)}
                  className="h-10"
                />
              </Field>
            ) : null}

            {/* ── Moving back: where they live ── */}
            {!leaving ? (
              <fieldset className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-sm font-semibold">{en ? 'Where do they live?' : 'أين يسكن؟'}</legend>
                {[...plan.homes.map((home) => ({ key: home.key, label: homeLabel(home) })), {
                  key: ELSEWHERE,
                  label: en ? 'Somewhere else in the town — add the card under Properties' : 'في مكان آخر في البلدة — تُضاف بطاقته في «العقارات»',
                }].map((choice) => (
                  <label key={choice.key} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="lives-in"
                      className="mt-1 size-4 accent-primary"
                      checked={livesIn === choice.key}
                      onChange={() => setLivesIn(choice.key)}
                    />
                    <span>{choice.label}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}

            {!leaving && plan.householdMissing.length > 0 ? (
              <p className="flex items-start gap-1.5 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {en ? 'The file now asks for: ' : 'يسأل الملف من الآن عن: '}
                  {plan.householdMissing
                    .map((field) => (labels.citizenField as Record<string, string>)[field] ?? field)
                    .join(en ? ', ' : '، ')}
                  {en
                    ? '. Fill them in on the form; what is not known can be marked «unestablished».'
                    : '. تُملأ في النموذج، وما لا يُعرف يُعلَّم «غير مؤكَّد».'}
                </span>
              </p>
            ) : null}

            {/* Asked on the deactivation too: it goes on the audit row with the day they left. */}
            <Field label={en ? 'Reason for the change' : 'سبب التعديل'} htmlFor={ids.reason} required>
              <Textarea
                id={ids.reason}
                value={reasonText}
                rows={2}
                maxLength={500}
                onChange={(event) => {
                  setReasonTouched(true);
                  setReason(event.target.value);
                }}
              />
            </Field>

            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
          </div>

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={onCorrect} disabled={deactivating} className="h-11 w-full sm:h-10 sm:w-auto">
              {death ? tKind('death.correct') : en ? 'Correct without a move' : 'تصحيح دون انتقال'}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={onCancel} disabled={deactivating} className="h-11 w-full sm:h-10 sm:w-auto">
                {en ? 'Cancel' : 'إلغاء'}
              </Button>
              {!(leaving && plan.nothingLeft) ? (
                <Button
                  disabled={!ready}
                  className={cn('h-11 w-full sm:h-10 sm:w-auto')}
                  onClick={() =>
                    onApply({
                      movedOn,
                      reason: reasonText,
                      ...(death
                        ? { homeStatuses: statuses }
                        : leaving
                          ? { residencePlace: place, homeStatuses: statuses }
                          : { livesIn: livesIn === ELSEWHERE ? null : livesIn }),
                    })
                  }
                >
                  {death ? tKind('death.apply') : en ? 'Apply to the form' : 'تطبيق على النموذج'}
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {endingCard?.id && token ? (
        <EndTenancyDialog
          tenant={tenant}
          token={token}
          propertyEntryId={endingCard.id}
          open={ending !== null}
          onOpenChange={(value) => {
            if (!value) setEnding(null);
          }}
          onEnded={(result, cardEnded) => {
            const index = ending!;
            setEnding(null);
            onTenancyEnded(index, result, cardEnded);
          }}
          defaults={{ reason: 'MOVED_OUT', endedAt: movedOn }}
          notice={
            death
              ? tKind('death.endNotice')
              : en
                ? 'Ended on the day of the move. What ends leaves the form; the rest of the form is unchanged.'
                : 'يُنهى بتاريخ الانتقال. ما يُنهى يخرج من النموذج، وباقي النموذج لا يتغيّر.'
          }
          locale={locale}
        />
      ) : null}
    </>
  );
}
