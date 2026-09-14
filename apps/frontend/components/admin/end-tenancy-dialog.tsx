'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { DoorOpen, Loader2 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  endTenancy,
  getTenancyEndPreview,
  logApiError,
  type AfterTenancyAnswer,
  type EndTenancyResult,
  type TenancyPreview,
} from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import {
  AfterTenancyQuestion,
  afterTenancyComplete,
  afterTenancyPayload,
  endTenancyMessage,
} from '@/components/admin/after-tenancy-question';

type Reason = 'MOVED_OUT' | 'RECORDED_IN_ERROR';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * «إنهاء الإيجار» — a tenant or free occupant has left.
 *
 * The same operation the unit matrix's «إنهاء الإشغال» runs, reached from the
 * card instead of the flat. It reads what the ending would touch before it asks
 * anything, so it only asks what applies: which flats (when the card names more
 * than one), and what each freed flat is now — never a flat somebody else is
 * still recorded living in.
 *
 * Nothing is deleted. The card stays on the tenant's file as an ended tenancy
 * with its lease, and the owner stays the owner.
 */
export function EndTenancyDialog({
  tenant,
  token,
  propertyEntryId,
  open,
  onOpenChange,
  onEnded,
  allowPartial = true,
  notice,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  propertyEntryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `cardEnded` is false when only some of the card's flats were given up. */
  onEnded: (result: EndTenancyResult, cardEnded: boolean) => void;
  /**
   * Whether the officer may end only some of the card's flats. Off in the edit
   * form, whose unsaved rows would otherwise write an ended flat back as held.
   */
  allowPartial?: boolean;
  /** One line about the place it was opened from, shown above the buttons. */
  notice?: string;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();
  const dateId = useId();

  const [preview, setPreview] = useState<TenancyPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [endedAt, setEndedAt] = useState(today());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [after, setAfter] = useState<AfterTenancyAnswer>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setLoadError(null);
      setReason(null);
      setEndedAt(today());
      setSelected(new Set());
      setAfter({});
      setFailure(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    getTenancyEndPreview(tenant, token, propertyEntryId)
      .then((found) => {
        if (controller.signal.aborted) return;
        setPreview(found);
        setSelected(new Set(found.units.map((unit) => unit.unitId)));
      })
      .catch((caught) => {
        logApiError(caught);
        if (!controller.signal.aborted) {
          setLoadError(
            caught instanceof ApiRequestError
              ? caught.payload.message
              : en
                ? 'Could not read this tenancy.'
                : 'تعذّر قراءة هذا الإيجار.',
          );
        }
      });
    return () => controller.abort();
  }, [open, tenant, token, propertyEntryId, en]);

  const units = useMemo(() => preview?.units ?? [], [preview]);
  const chosen = useMemo(() => units.filter((unit) => selected.has(unit.unitId)), [units, selected]);
  const everyUnit = chosen.length === units.length;
  const freed = chosen.filter((unit) => unit.needsStatus);
  const kept = chosen.filter((unit) => unit.othersRemain);
  const asksStatus = freed.length > 0;
  const ownerNonResident = freed.some((unit) => unit.ownerNonResident && unit.dwelling);
  const partial = allowPartial && units.length > 1;
  const free = preview?.occupancyType === 'FREE_OCCUPANT';

  const ready =
    Boolean(preview) &&
    Boolean(reason) &&
    (units.length === 0 || chosen.length > 0) &&
    (!asksStatus || afterTenancyComplete(after));

  const toggle = (unitId: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(unitId);
      else next.delete(unitId);
      return next;
    });

  const run = async () => {
    if (!reason || !ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await endTenancy(tenant, token, propertyEntryId, {
        reason,
        ...(reason === 'MOVED_OUT' && endedAt && endedAt !== today() ? { endedAt } : {}),
        // All of them is the whole card — including rows never linked to a flat.
        ...(everyUnit ? {} : { unitIds: chosen.map((unit) => unit.unitId) }),
        ...(asksStatus ? afterTenancyPayload(after) : {}),
      });
      onOpenChange(false);
      onEnded(result, result.cardsEnded > 0);
      toast.success(endTenancyMessage(result, locale));
    } catch (caught) {
      logApiError(caught);
      setFailure(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not end the tenancy.'
            : 'تعذّر إنهاء الإيجار.',
      );
      setBusy(false);
    }
  };

  const action = free
    ? en
      ? 'End occupancy'
      : 'إنهاء الإشغال'
    : en
      ? 'End tenancy'
      : 'إنهاء الإيجار';

  const codes = (list: typeof units) => (
    <bdi dir="ltr" className="font-mono">
      {list.map((unit) => unit.unitCode).join(', ')}
    </bdi>
  );

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <DoorOpen className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>
                {preview?.tenant.name
                  ? en
                    ? `${action}: ${preview.tenant.name}?`
                    : `${action}: ${preview.tenant.name}؟`
                  : `${action}${en ? '?' : '؟'}`}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? 'Use this when they have left the property. Nothing is deleted: the card stays on their file as an ended tenancy, with its documents.'
                  : 'استخدم هذا عندما يترك العقار. لا يُحذف شيء: تبقى البطاقة في ملفه كإيجار منتهٍ مع مستنداتها.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {loadError ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
            {loadError}
          </p>
        ) : !preview ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {en ? 'Reading this tenancy…' : 'جارٍ قراءة الإيجار…'}
          </p>
        ) : (
          <div className="space-y-4">
            {partial ? (
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-sm font-medium">
                  {en ? 'Which units did they leave?' : 'أي الوحدات تركها؟'}{' '}
                  <span className="text-destructive">*</span>
                </legend>
                <div className="grid gap-2">
                  {units.map((unit) => {
                    const on = selected.has(unit.unitId);
                    return (
                      <label
                        key={unit.unitId}
                        className={cn(
                          'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors duration-150',
                          on ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                        )}
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={(value) => toggle(unit.unitId, value === true)}
                          className="size-5"
                        />
                        <span className="min-w-0 flex-1">
                          <bdi dir="ltr" className="font-mono font-medium">
                            {unit.unitCode}
                          </bdi>
                          {unit.ownerNames.length > 0 ? (
                            <span className="ms-2 text-xs text-muted-foreground">
                              {en ? 'Owner: ' : 'المالك: '}
                              {unit.ownerNames.join('، ')}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : units.length === 1 ? (
              <p className="text-sm">
                {en ? 'Unit ' : 'الوحدة '}
                {codes(units)}
                {units[0]!.ownerNames.length > 0 ? (
                  <span className="text-muted-foreground">
                    {en ? ' — owner: ' : ' — المالك: '}
                    {units[0]!.ownerNames.join('، ')}
                  </span>
                ) : null}
              </p>
            ) : units.length === 0 ? (
              <p className="rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
                {en
                  ? 'This card is not linked to a unit in the building register, so only the card ends.'
                  : 'هذه البطاقة غير مربوطة بوحدة في سجل المباني، فتنتهي البطاقة وحدها.'}
              </p>
            ) : (
              <p className="text-sm">
                {en ? 'Every unit on the card: ' : 'كل وحدات البطاقة: '}
                {codes(units)}
              </p>
            )}

            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-sm font-medium">
                {en ? 'Why?' : 'السبب'} <span className="text-destructive">*</span>
              </legend>
              <div className="grid gap-2" role="radiogroup">
                {(['MOVED_OUT', 'RECORDED_IN_ERROR'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={reason === option}
                    onClick={() => setReason(option)}
                    className={cn(
                      'min-h-11 rounded-md border px-3 py-2 text-start text-sm transition-colors duration-150',
                      reason === option
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'hover:bg-accent',
                    )}
                  >
                    {labels.occupancyEndReason[option]}
                  </button>
                ))}
              </div>
            </fieldset>

            {reason === 'MOVED_OUT' ? (
              <Field label={en ? 'Left on' : 'تاريخ الخروج'} htmlFor={dateId}>
                <Input
                  id={dateId}
                  type="date"
                  min={preview.startedAt?.slice(0, 10)}
                  max={today()}
                  value={endedAt}
                  onChange={(event) => setEndedAt(event.target.value)}
                  dir="ltr"
                  className="text-start"
                />
              </Field>
            ) : null}

            {reason && asksStatus ? (
              <div className="space-y-1.5">
                {units.length > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    {en ? 'For ' : 'عن '}
                    {codes(freed)}
                  </p>
                ) : null}
                <AfterTenancyQuestion
                  value={after}
                  onChange={setAfter}
                  ownerNonResident={ownerNonResident}
                  locale={locale}
                />
              </div>
            ) : null}

            {reason && kept.length > 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {en ? 'Somebody else is still recorded living in ' : 'ما زال شخص آخر مسجَّلاً ساكناً في '}
                {codes(kept)}
                {en ? ', so its status stays as it is.' : '، فتبقى حالتها كما هي.'}
              </p>
            ) : null}

            {reason ? (
              <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed">
                <li>
                  {en ? 'They stop being charged for ' : 'تتوقف الرسوم عليه عن '}
                  {units.length === 0
                    ? en
                      ? 'this property.'
                      : 'هذا العقار.'
                    : chosen.length === 1
                      ? en
                        ? 'this unit.'
                        : 'هذه الوحدة.'
                      : en
                        ? 'these units.'
                        : 'هذه الوحدات.'}
                </li>
                <li>
                  {everyUnit
                    ? en
                      ? 'The card stays on their file marked «Ended», lease and documents included.'
                      : 'تبقى البطاقة في ملفه بعلامة «منتهية» مع العقد والمستندات.'
                    : en
                      ? 'The card stays current for the units they kept; the others are recorded as ended on it.'
                      : 'تبقى البطاقة قائمة للوحدات التي بقي فيها، وتُسجَّل الأخرى عليها كمنتهية.'}
                </li>
                {reason === 'MOVED_OUT' ? (
                  <li>
                    {preview.landlordName
                      ? en
                        ? `${preview.landlordName} stays the owner, and the link is kept as history.`
                        : `يبقى ${preview.landlordName} مالكاً، ويُحفظ الربط كسجل سابق.`
                      : en
                        ? 'The owner stays the owner.'
                        : 'يبقى المالك مالكاً.'}
                  </li>
                ) : preview.landlordName ? (
                  <li>
                    {en
                      ? `What linking ${preview.landlordName} added to their file for these units is undone, as it rested on this record.`
                      : `يُلغى ما أضافه ربط ${preview.landlordName} إلى ملفه عن هذه الوحدات، لأنه قام على هذا السجل.`}
                  </li>
                ) : null}
                {reason === 'MOVED_OUT' && preview.startedAt ? (
                  <li className="text-muted-foreground">
                    {en ? 'Recorded here since ' : 'مسجَّل فيها منذ '}
                    {formatDate(preview.startedAt)}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}

        {notice && preview ? (
          <p className="rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">{notice}</p>
        ) : null}

        {failure ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
            {failure}
          </p>
        ) : null}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="h-11 w-full sm:h-10 sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void run()}
            disabled={busy || !ready}
            className="h-11 w-full transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none sm:h-10 sm:w-auto"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <DoorOpen className="size-4" aria-hidden />
            )}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
