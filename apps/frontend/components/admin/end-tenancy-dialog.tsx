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
  type TenancyPreviewRow,
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
 * anything, so it only asks what applies: which of the card's rows they left,
 * and what each freed flat is now — never a flat somebody else is still
 * recorded living in.
 *
 * ## Every row, and nothing chosen for the officer
 *
 * It used to list only the flats linked to سجل المباني, pre-tick all of them,
 * and send no choice when every box stayed ticked — which the server read as
 * «end every row on the card». A card holding one linked flat and a shop typed
 * on the form showed the flat alone and ended both. So every current row is
 * listed, a card with more than one starts with none chosen, and the rows
 * chosen are sent by id, every time.
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
  notice,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  propertyEntryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `cardEnded` is false when only some of the card's rows were given up. */
  onEnded: (result: EndTenancyResult, cardEnded: boolean) => void;
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
        // A lone row is the tenancy itself; among several, nothing is chosen for the officer.
        const rows = found.rows ?? [];
        setSelected(new Set(rows.length === 1 ? [rows[0]!.rowId] : []));
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

  const rows = useMemo(() => preview?.rows ?? [], [preview]);
  /**
   * What ends: the chosen rows, or — on a منزل, which has no rows — its one flat.
   * Only a linked flat carries a census status to ask about.
   */
  const houseUnits = useMemo(() => (rows.length === 0 ? (preview?.units ?? []) : []), [rows, preview]);
  const chosen = useMemo(() => rows.filter((row) => selected.has(row.rowId)), [rows, selected]);
  const ending = rows.length > 0 ? chosen : houseUnits;
  const everyRow = rows.length === 0 || chosen.length === rows.length;
  const freed = ending.filter((unit) => unit.needsStatus);
  const kept = ending.filter((unit) => unit.othersRemain);
  const asksStatus = freed.length > 0;
  const ownerNonResident = freed.some((unit) => unit.ownerNonResident && unit.dwelling);
  const free = preview?.occupancyType === 'FREE_OCCUPANT';

  const ready =
    Boolean(preview) &&
    Boolean(reason) &&
    (rows.length === 0 || chosen.length > 0) &&
    (!asksStatus || afterTenancyComplete(after));

  const toggle = (rowId: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(rowId);
      else next.delete(rowId);
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
        // Exactly the rows chosen, always — never «whatever is on the card».
        ...(rows.length > 0 ? { rowIds: chosen.map((row) => row.rowId) } : {}),
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

  const codes = (list: ReadonlyArray<{ unitCode: string | null }>) => (
    <bdi dir="ltr" className="font-mono">
      {list
        .map((unit) => unit.unitCode)
        .filter(Boolean)
        .join(', ')}
    </bdi>
  );

  /** A row as the card shows it: its flat's code, or what the form said about the line. */
  const rowLabel = (row: TenancyPreviewRow) => (
    <span className="min-w-0 flex-1">
      {row.unitCode ? (
        <bdi dir="ltr" className="font-mono font-medium">
          {row.unitCode}
        </bdi>
      ) : (
        <span className="font-medium">
          {row.unitType ? (labels.unitType[row.unitType as never] ?? row.unitType) : en ? 'Unit' : 'وحدة'}
        </span>
      )}
      {row.floor ? (
        <span className="ms-2 text-xs text-muted-foreground">
          {en ? `Floor ${row.floor}` : `الطابق ${row.floor}`}
        </span>
      ) : null}
      {row.unitArea != null ? (
        <span className="ms-2 text-xs text-muted-foreground">
          {row.unitArea} {en ? 'm²' : 'م²'}
        </span>
      ) : null}
      {row.ownerNames.length > 0 ? (
        <span className="ms-2 text-xs text-muted-foreground">
          {en ? 'Owner: ' : 'المالك: '}
          {row.ownerNames.join('، ')}
        </span>
      ) : null}
      {!row.unitId ? (
        <span className="ms-2 text-xs text-muted-foreground">
          {en ? '(not linked to the building register)' : '(غير مربوطة بسجل المباني)'}
        </span>
      ) : null}
    </span>
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
            {rows.length > 1 ? (
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-sm font-medium">
                  {en ? 'Which units did they leave?' : 'أي الوحدات تركها؟'}{' '}
                  <span className="text-destructive">*</span>
                </legend>
                <p className="text-xs text-muted-foreground">
                  {en
                    ? 'Tick only what they left. The rest stay on the card as current.'
                    : 'حدِّد ما تركه فقط، ويبقى الباقي قائماً على البطاقة.'}
                </p>
                <div className="grid gap-2">
                  {rows.map((row) => {
                    const on = selected.has(row.rowId);
                    return (
                      <label
                        key={row.rowId}
                        className={cn(
                          'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors duration-150',
                          on ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                        )}
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={(value) => toggle(row.rowId, value === true)}
                          className="size-5"
                        />
                        {rowLabel(row)}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : rows.length === 1 ? (
              <p className="flex text-sm">{rowLabel(rows[0]!)}</p>
            ) : houseUnits.length > 0 ? (
              <p className="text-sm">
                {en ? 'Unit ' : 'الوحدة '}
                {codes(houseUnits)}
                {houseUnits[0]!.ownerNames.length > 0 ? (
                  <span className="text-muted-foreground">
                    {en ? ' — owner: ' : ' — المالك: '}
                    {houseUnits[0]!.ownerNames.join('، ')}
                  </span>
                ) : null}
              </p>
            ) : (
              <p className="rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
                {en
                  ? 'This card is not linked to a unit in the building register, so only the card ends.'
                  : 'هذه البطاقة غير مربوطة بوحدة في سجل المباني، فتنتهي البطاقة وحدها.'}
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
                {rows.length > 1 ? (
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
                  {ending.length === 0
                    ? en
                      ? 'this property.'
                      : 'هذا العقار.'
                    : ending.length === 1
                      ? en
                        ? 'this unit.'
                        : 'هذه الوحدة.'
                      : en
                        ? 'these units.'
                        : 'هذه الوحدات.'}
                </li>
                <li>
                  {everyRow
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
