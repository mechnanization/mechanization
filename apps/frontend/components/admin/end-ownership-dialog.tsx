'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, Search, UserRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  endOccupancy,
  endOwnership,
  getOccupancyOwnershipPreview,
  getOwnershipEndPreview,
  isOwnershipResult,
  listCitizens,
  logApiError,
  type AfterTenancyAnswer,
  type CitizenListItem,
  type EndOwnershipResult,
  type OwnershipLinkedTenant,
  type OwnershipPreview,
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
  endOwnershipMessage,
} from '@/components/admin/after-tenancy-question';

type Reason = 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';

/** Who the new owner is: a registered citizen, or «not registered yet». */
type Buyer = { kind: 'citizen'; id: string; name: string } | { kind: 'unregistered' };

const today = () => new Date().toISOString().slice(0, 10);
const SEARCH_DEBOUNCE_MS = 350;

/**
 * «إنهاء الملكية» — an owner sold, or a property passed on, or it was never theirs.
 *
 * The owner's sibling of «إنهاء الإيجار»: the same order of questions, the same
 * answer cards with what each does to the bill written under it, and the same
 * «ماذا سيحدث» list before anything is pressed. Reached from the owner's card
 * (`source.kind === 'card'`) and from their row on the unit matrix
 * (`'occupancy'`), both of which end through one server operation.
 *
 * ## What it asks, and only when it applies
 *
 *  1. Which flats — only for a card holding several; nothing is pre-ticked.
 *  2. What happened — a sale or transfer, or an entry made by mistake. No
 *     default: a preselected answer is the one muscle memory confirms.
 *  3. For a sale: when, and who the new owner is — a registered citizen found
 *     by search, or «ليس مسجَّلاً بعد», which opens a task and offers a new
 *     file straight after.
 *  4. For a sale of a flat the seller lived in, with no co-owner left: who lives
 *     there now. «يسكنها المالك الجديد» waits until a buyer is chosen.
 *
 * A correction while a tenant's link names this person as their landlord is
 * stopped here, with the way out — the tenant's file — rather than refused by
 * the server after the officer has answered everything.
 *
 * ## Why the success screen
 *
 * A sale with nobody recorded as buyer leaves one job behind, and the officer
 * is usually standing in front of the person who can answer it. So instead of
 * closing on a toast, the dialog says what happened and offers «سجِّل المالك
 * الجديد الآن». `onEnded` runs when it closes, so a card that disappears from
 * the form does not take this screen with it.
 */
export function EndOwnershipDialog({
  tenant,
  token,
  source,
  open,
  onOpenChange,
  onEnded,
  newFileTarget = '_self',
  notice,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  source: { kind: 'card'; propertyEntryId: string } | { kind: 'occupancy'; occupancyId: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the dialog closes after a successful ending. */
  onEnded: (result: EndOwnershipResult) => void;
  /**
   * Where «سجِّل المالك الجديد الآن» opens. `_blank` from an edit form, so the
   * form and its unsaved answers stay where the officer left them.
   */
  newFileTarget?: '_self' | '_blank';
  /** One line about the place it was opened from, shown above the buttons. */
  notice?: string;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();
  const dateId = useId();
  const params = useParams<{ tenant?: string; locale?: string; adminPath?: string }>();
  const base =
    params?.tenant && params?.locale && params?.adminPath
      ? `/${params.tenant}/${params.locale}/${params.adminPath}`
      : null;

  const [preview, setPreview] = useState<OwnershipPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<Reason | null>(null);
  const [endedAt, setEndedAt] = useState(today());
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [after, setAfter] = useState<AfterTenancyAnswer>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<EndOwnershipResult | null>(null);

  const sourceKey = source.kind === 'card' ? source.propertyEntryId : source.occupancyId;

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setLoadError(null);
      setSelected(new Set());
      setReason(null);
      setEndedAt(today());
      setBuyer(null);
      setAfter({});
      setBusy(false);
      setFailure(null);
      setDone(null);
      return;
    }
    const controller = new AbortController();
    const read =
      source.kind === 'card'
        ? getOwnershipEndPreview(tenant, token, source.propertyEntryId)
        : getOccupancyOwnershipPreview(tenant, token, source.occupancyId);
    read
      .then((found) => {
        if (controller.signal.aborted) return;
        setPreview(found);
        // A lone row is the ownership itself; among several, nothing is chosen for the officer.
        setSelected(new Set(found.rows.length === 1 ? [found.rows[0]!.rowId] : []));
      })
      .catch((caught) => {
        logApiError(caught);
        if (!controller.signal.aborted) {
          setLoadError(
            caught instanceof ApiRequestError
              ? caught.payload.message
              : en
                ? 'Could not read this ownership.'
                : 'تعذّر قراءة هذه الملكية.',
          );
        }
      });
    return () => controller.abort();
    // `source` is identified by its key; a new object for the same key is the same ownership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenant, token, source.kind, sourceKey, en]);

  const rows = useMemo(() => preview?.rows ?? [], [preview]);
  const chosenRows = useMemo(() => rows.filter((row) => selected.has(row.rowId)), [rows, selected]);
  /** The flats ending: the chosen rows' flats, or — with no rows — every flat the ownership holds. */
  const endingUnits = useMemo(() => {
    const units = preview?.units ?? [];
    if (rows.length === 0) return units;
    const ids = new Set(chosenRows.map((row) => row.unitId).filter(Boolean));
    return units.filter((unit) => ids.has(unit.unitId));
  }, [preview, rows, chosenRows]);

  const sale = reason === 'OWNERSHIP_TRANSFERRED';
  const asksStatus = sale && endingUnits.some((unit) => unit.needsStatus);
  const coOwned = endingUnits.filter((unit) => unit.otherOwners.length > 0);
  const tenants = uniqueTenants(endingUnits.flatMap((unit) => unit.linkedTenants));
  const blockedByTenants = reason === 'RECORDED_IN_ERROR' && tenants.length > 0;
  const everyRow = rows.length === 0 || chosenRows.length === rows.length;
  /*
    A buyer who is already on the flat. A co-owner keeps what they hold; a
    tenant has to end the tenancy first, where its own questions are asked —
    recording them as owner over it would rewrite that tenancy.
  */
  const buyerId = sale && buyer?.kind === 'citizen' ? buyer.id : null;
  const buyerOccupies = buyerId ? endingUnits.filter((unit) => unit.occupantIds.includes(buyerId)) : [];
  const buyerOwns = buyerId ? endingUnits.filter((unit) => unit.otherOwnerIds.includes(buyerId)) : [];

  const ready =
    Boolean(preview) &&
    Boolean(reason) &&
    (rows.length <= 1 || chosenRows.length > 0) &&
    !blockedByTenants &&
    buyerOccupies.length === 0 &&
    (!sale || Boolean(buyer)) &&
    (!asksStatus || afterTenancyComplete(after)) &&
    !(after.afterStatus === 'OWNER_OCCUPIED' && buyer?.kind !== 'citizen');

  // The buyer changed away from a registered one: «يسكنها المالك الجديد» no longer has anyone to mean.
  useEffect(() => {
    if (buyer?.kind !== 'citizen' && after.afterStatus === 'OWNER_OCCUPIED') setAfter({});
  }, [buyer, after.afterStatus]);

  const toggle = (rowId: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(rowId);
      else next.delete(rowId);
      return next;
    });

  const close = (next: boolean) => {
    if (busy) return;
    if (!next && done) onEnded(done);
    onOpenChange(next);
  };

  const run = async () => {
    if (!reason || !ready || busy || !preview) return;
    setBusy(true);
    setFailure(null);
    const answer = {
      reason,
      ...(sale && endedAt && endedAt !== today() ? { endedAt } : {}),
      ...(sale && buyer?.kind === 'citizen' ? { newOwnerId: buyer.id } : {}),
      ...(asksStatus ? afterTenancyPayload(after) : {}),
    };
    try {
      let result: EndOwnershipResult;
      if (source.kind === 'card') {
        result = await endOwnership(tenant, token, source.propertyEntryId, {
          ...answer,
          ...(rows.length > 0 ? { rowIds: chosenRows.map((row) => row.rowId) } : {}),
        });
      } else {
        const { endedAt: toDate, ...rest } = answer as typeof answer & { endedAt?: string };
        const ended = await endOccupancy(tenant, token, source.occupancyId, {
          ...rest,
          ...(toDate ? { toDate } : {}),
        });
        if (!isOwnershipResult(ended)) throw new Error(en ? 'Unexpected response.' : 'ردّ غير متوقَّع من الخادم.');
        result = ended;
      }

      toast.success(endOwnershipMessage(result, locale));
      // A sale with no buyer recorded leaves a job the officer can do now.
      if (result.reason === 'OWNERSHIP_TRANSFERRED' && !result.newOwnerRecorded) {
        setDone(result);
        setBusy(false);
        return;
      }
      onOpenChange(false);
      onEnded(result);
    } catch (caught) {
      logApiError(caught);
      setFailure(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : caught instanceof Error && caught.message
            ? caught.message
            : en
              ? 'Could not end the ownership.'
              : 'تعذّر إنهاء الملكية.',
      );
      setBusy(false);
    }
  };

  const ownerName = preview?.owner.name ?? '';
  const codes = (list: ReadonlyArray<{ unitCode: string | null }>) => (
    <bdi dir="ltr" className="font-mono">
      {list
        .map((unit) => unit.unitCode)
        .filter(Boolean)
        .join('، ')}
    </bdi>
  );

  // ── After a sale with nobody recorded as buyer ──
  if (done) {
    const unit = done.units[0];
    const newFileHref =
      base && unit
        ? `${base}/citizens/new?buildingId=${encodeURIComponent(unit.buildingId)}&unitId=${encodeURIComponent(unit.unitId)}`
        : null;
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-md" closeLabel={en ? 'Close' : 'إغلاق'}>
          <DialogHeader>
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"
              >
                <CheckCircle2 className="size-5" />
              </span>
              <div className="min-w-0 space-y-1.5 text-start">
                <DialogTitle>{en ? `${ownerName}'s ownership ended` : `انتهت ملكية ${ownerName}`}</DialogTitle>
                <DialogDescription>
                  {en ? 'A task is open on ' : 'فُتحت مهمة على '}
                  {done.units.length > 0 ? codes(done.units) : en ? 'the property' : 'العقار'}
                  {en
                    ? ' to record the new owner. If they are here, register them now.'
                    : ' لتسجيل المالك الجديد. إن كان حاضراً فسجِّله الآن.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {done.tenantsReleased.length > 0 ? (
            <p className="rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
              {en
                ? `After registering the new owner, link ${done.tenantsReleased.map((row) => row.tenantName).join(', ')} to them from «Owner links».`
                : `بعد تسجيل المالك الجديد اربط ${done.tenantsReleased.map((row) => row.tenantName).join('، ')} به من «روابط المالكين».`}
            </p>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => close(false)} className="h-11 w-full sm:h-10 sm:w-auto">
              {en ? 'Later' : 'لاحقاً'}
            </Button>
            {newFileHref ? (
              <Button asChild className="h-11 w-full sm:h-10 sm:w-auto">
                <Link
                  href={newFileHref}
                  target={newFileTarget}
                  rel={newFileTarget === '_blank' ? 'noopener' : undefined}
                  onClick={() => {
                    if (newFileTarget === '_self') close(false);
                  }}
                >
                  <UserRound className="size-4" aria-hidden />
                  {en ? 'Register the new owner now' : 'سجِّل المالك الجديد الآن'}
                  {newFileTarget === '_blank' ? <ExternalLink className="size-3.5 opacity-70" aria-hidden /> : null}
                </Link>
              </Button>
            ) : null}
          </DialogFooter>
          {newFileHref ? (
            <p className="-mt-1 text-center text-xs text-muted-foreground sm:text-end">
              {en ? 'Choose «Owner» as the occupancy type in the new file.' : 'اختر «مالك» في نوع الإشغال في الملف الجديد.'}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    );
  }

  const action = sale ? (en ? 'End ownership' : 'إنهاء الملكية') : reason ? (en ? 'Correct ownership' : 'تصحيح الملكية') : en ? 'End ownership' : 'إنهاء الملكية';

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <KeyRound className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>
                {ownerName
                  ? en
                    ? `End ownership: ${ownerName}?`
                    : `إنهاء الملكية: ${ownerName}؟`
                  : en
                    ? 'End ownership?'
                    : 'إنهاء الملكية؟'}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? 'For a sale, an inheritance or a gift — or to correct an ownership entered by mistake. Nothing is deleted: the card stays on their file as a record.'
                  : 'للبيع أو انتقال الملكية بإرث أو هبة، أو لتصحيح ملكية سُجِّلت بالخطأ. لا يُحذف شيء: تبقى البطاقة في ملفه كسجل.'}
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
            {en ? 'Reading this ownership…' : 'جارٍ قراءة الملكية…'}
          </p>
        ) : (
          <div className="space-y-4">
            {/* ── Which flats ── */}
            {rows.length > 1 ? (
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-sm font-medium">
                  {en ? 'Which units?' : 'أي الوحدات؟'} <span className="text-destructive">*</span>
                </legend>
                <p className="text-xs text-muted-foreground">
                  {en
                    ? 'Tick only the units whose ownership ended. The rest stay theirs.'
                    : 'حدِّد الوحدات التي انتهت ملكيتها فقط، ويبقى الباقي ملكاً له.'}
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
                        <UnitLine
                          code={row.unitCode}
                          type={row.unitType ? (labels.unitType[row.unitType as never] ?? row.unitType) : null}
                          floor={row.floor}
                          area={row.unitArea}
                          en={en}
                        />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : endingUnits.length > 0 ? (
              <p className="text-sm">
                {preview.propertyNumber ? (
                  <span className="text-muted-foreground">
                    {en ? 'Parcel ' : 'العقار '}
                    <bdi dir="ltr" className="font-mono">
                      {preview.propertyNumber}
                    </bdi>
                    {' · '}
                  </span>
                ) : null}
                {en ? 'Unit ' : 'الوحدة '}
                {codes(endingUnits)}
                {preview.startedAt ? (
                  <span className="text-muted-foreground">
                    {en ? ' · owner since ' : ' · مالك منذ '}
                    {formatDate(preview.startedAt)}
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

            {/* ── What happened ── */}
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-sm font-medium">
                {en ? 'What happened?' : 'ماذا حدث؟'} <span className="text-destructive">*</span>
              </legend>
              <div className="grid gap-2" role="radiogroup">
                {(
                  [
                    {
                      value: 'OWNERSHIP_TRANSFERRED',
                      title: en ? 'Sold or passed on' : 'بيع أو انتقال ملكية',
                      effect: en
                        ? 'Sale, inheritance, gift… Their ownership ends on the date you give, and owner fees stop being charged to them from then.'
                        : 'بيع، إرث، هبة… تنتهي ملكيته من التاريخ الذي تحدده، ويتوقف تحصيل رسوم المالك منه عنها.',
                    },
                    {
                      value: 'RECORDED_IN_ERROR',
                      title: en ? 'Entered by mistake' : 'سُجِّلت بالخطأ',
                      effect: en
                        ? 'They never owned it. The entry is corrected and leaves the unit’s history.'
                        : 'لم يكن مالكاً لها أصلاً. تُصحَّح وتخرج من سجل الوحدة.',
                    },
                  ] as const
                ).map((option) => {
                  const on = reason === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setReason(option.value)}
                      className={cn(
                        'min-h-11 rounded-md border px-3 py-2.5 text-start text-sm transition-colors duration-150',
                        on ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                      )}
                    >
                      <span className={cn('block font-medium', on && 'text-primary')}>{option.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{option.effect}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* ── A correction a tenant's link stands in the way of ── */}
            {blockedByTenants ? (
              <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="flex items-start gap-2 font-medium text-warning">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {en ? 'Undo the tenant’s link first' : 'ألغِ ربط المستأجر أولاً'}
                </p>
                <p className="text-xs leading-relaxed text-foreground">
                  {en
                    ? 'This person is recorded as the landlord on a tenant’s card. That link is the tenant’s record: undo it from their card («Unlink»), then come back to correct this ownership.'
                    : 'هذا الشخص مسجَّل مالكاً في بطاقة مستأجر، والربط من سجلّ المستأجر. ألغِه من بطاقته («إلغاء الربط»)، ثم عُد لتصحيح هذه الملكية.'}
                </p>
                {base ? (
                  <ul className="space-y-1">
                    {tenants.map((tenantRow) => (
                      <li key={tenantRow.propertyEntryId}>
                        <Link
                          href={`${base}/citizens/${encodeURIComponent(tenantRow.citizenId)}`}
                          target="_blank"
                          rel="noopener"
                          className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {en ? `Open ${tenantRow.name}’s file` : `افتح ملف ${tenantRow.name}`}
                          <ExternalLink className="size-3.5" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {/* ── A sale: when, and to whom ── */}
            {sale ? (
              <>
                <Field label={en ? 'Date of sale or transfer' : 'تاريخ انتقال الملكية'} htmlFor={dateId}>
                  <Input
                    id={dateId}
                    type="date"
                    min={preview.startedAt?.slice(0, 10)}
                    max={today()}
                    value={endedAt}
                    onChange={(event) => setEndedAt(event.target.value)}
                    dir="ltr"
                    className="text-start"
                    aria-describedby={`${dateId}-help`}
                  />
                  <p id={`${dateId}-help`} className="mt-1 text-xs text-muted-foreground">
                    {en
                      ? 'From this date they are no longer charged owner fees for these units.'
                      : 'من هذا التاريخ لا تُحتسب عليه رسوم المالك عن هذه الوحدات.'}
                  </p>
                </Field>

                <BuyerPicker
                  tenant={tenant}
                  token={token}
                  sellerId={preview.owner.id}
                  value={buyer}
                  onChange={setBuyer}
                  locale={locale}
                />

                {buyer?.kind === 'citizen' && buyerOccupies.length > 0 ? (
                  <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                    <p className="flex items-start gap-2 font-medium text-warning">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {en ? 'End their tenancy first' : 'أنهِ إيجاره أولاً'}
                    </p>
                    <p className="text-xs leading-relaxed text-foreground">
                      {en ? `${buyer.name} is recorded living in ` : `${buyer.name} مسجَّل ساكناً في `}
                      {codes(buyerOccupies)}
                      {en
                        ? ' as a tenant or occupant. End that tenancy from their file («End tenancy»), dated the day of the sale, then come back and record the sale.'
                        : ' مستأجراً أو بتسامح. أنهِ إيجاره من ملفه («إنهاء الإيجار») بتاريخ البيع، ثم عُد وسجِّل البيع.'}
                    </p>
                    {base ? (
                      <Link
                        href={`${base}/citizens/${encodeURIComponent(buyer.id)}`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {en ? `Open ${buyer.name}’s file` : `افتح ملف ${buyer.name}`}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                ) : null}

                {asksStatus ? (
                  <div className="space-y-1.5">
                    {endingUnits.length > 1 ? (
                      <p className="text-xs text-muted-foreground">
                        {en ? 'For ' : 'عن '}
                        {codes(endingUnits.filter((unit) => unit.needsStatus))}
                      </p>
                    ) : null}
                    <AfterTenancyQuestion
                      value={after}
                      onChange={setAfter}
                      legend={en ? 'Who lives there now?' : 'من يسكن الوحدة الآن؟'}
                      ownerOption={{
                        title: en ? 'The new owner lives there' : 'يسكنها المالك الجديد',
                        effect: en
                          ? 'The new owner is recorded living there and bears the occupancy fee.'
                          : 'يُسجَّل المالك الجديد ساكناً فيها ويتحمّل رسم الإشغال.',
                        disabled:
                          buyer?.kind === 'citizen'
                            ? undefined
                            : en
                              ? 'Choose the new owner above first.'
                              : 'اختر المالك الجديد أعلاه أولاً.',
                      }}
                      locale={locale}
                    />
                  </div>
                ) : null}

                {coOwned.length > 0 ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {coOwned.map((unit) => unit.otherOwners.join('، ')).join('، ')}
                    {en ? ' still own ' : ' يبقى مالكاً لـ '}
                    {codes(coOwned)}
                    {en ? ', so its status stays as it is.' : '، فتبقى حالتها كما هي.'}
                  </p>
                ) : null}
              </>
            ) : null}

            {/* ── What will happen ── */}
            {reason && !blockedByTenants ? (
              <div className="rounded-md bg-muted/40 p-3">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {en ? 'What will happen' : 'ماذا سيحدث'}
                </p>
                <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed">
                  {sale ? (
                    <>
                      <li>
                        {en
                          ? `${ownerName} stops being charged owner fees for ${endingUnits.length === 1 ? 'this unit' : endingUnits.length ? 'these units' : 'this property'} from ${formatDate(endedAt || today())}.`
                          : `يتوقف تحصيل رسوم المالك من ${ownerName} عن ${endingUnits.length === 1 ? 'هذه الوحدة' : endingUnits.length ? 'هذه الوحدات' : 'هذا العقار'} من ${formatDate(endedAt || today())}.`}
                      </li>
                      <li>
                        {everyRow
                          ? en
                            ? 'The card stays on their file marked «Ended».'
                            : 'تبقى البطاقة في ملفه بعلامة «منتهية».'
                          : en
                            ? 'The card stays current for the units they keep; the others are recorded as ended on it.'
                            : 'تبقى البطاقة قائمة للوحدات التي بقيت له، وتُسجَّل الأخرى عليها كمنتهية.'}
                      </li>
                      {buyer?.kind !== 'citizen' ? (
                        <li>
                          {en
                            ? 'A task is opened to record the new owner — you can open their file straight after.'
                            : 'تُفتح مهمة لتسجيل المالك الجديد — ويمكنك فتح ملف له مباشرة بعد الحفظ.'}
                        </li>
                      ) : buyerOwns.length < endingUnits.length || endingUnits.length === 0 ? (
                        <li>
                          {en
                            ? `${buyer.name} is recorded as the owner from the same date.`
                            : `يُسجَّل ${buyer.name} مالكاً من التاريخ نفسه.`}
                        </li>
                      ) : null}
                      {buyer?.kind === 'citizen' && buyerOwns.length > 0 ? (
                        <li>
                          {en ? `${buyer.name} already owns ` : `${buyer.name} مالك مسبقاً لـ`}
                          {codes(buyerOwns)}
                          {en ? ', so that ownership stays as it is.' : '، فتبقى ملكيته كما هي.'}
                        </li>
                      ) : null}
                      {tenants.map((tenantRow) => (
                        <li key={tenantRow.propertyEntryId}>
                          {en
                            ? `${tenantRow.name} stays the tenant. Their card keeps ${ownerName} as the former landlord, the link to them is released, and a task asks to link them to the new owner.`
                            : `يبقى ${tenantRow.name} مستأجراً كما هو. تحتفظ بطاقته بـ${ownerName} مالكاً سابقاً، ويُفصل ربطه به، وتُفتح مهمة لربطه بالمالك الجديد.`}
                        </li>
                      ))}
                    </>
                  ) : (
                    <>
                      <li>
                        {en
                          ? 'The ownership is recorded as an entry made by mistake and leaves the unit’s history.'
                          : 'تُسجَّل الملكية كإدخال خاطئ وتخرج من سجل الوحدة.'}
                      </li>
                      <li>
                        {en
                          ? 'The card is not deleted: it stays on their file as an ended record, for review.'
                          : 'لا تُحذف البطاقة: تبقى في ملفه كسجل منتهٍ للمراجعة.'}
                      </li>
                      <li>
                        {en ? 'Owner fees for it stop being charged to them.' : 'يتوقف تحصيل رسوم المالك منه عنها.'}
                      </li>
                    </>
                  )}
                </ul>
              </div>
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
            onClick={() => close(false)}
            disabled={busy}
            className="h-11 w-full sm:h-10 sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            variant={reason === 'RECORDED_IN_ERROR' ? 'destructive' : 'default'}
            onClick={() => void run()}
            disabled={busy || !ready}
            className="h-11 w-full transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none sm:h-10 sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One flat on the card, as the rows list shows it. */
function UnitLine({
  code,
  type,
  floor,
  area,
  en,
}: {
  code: string | null;
  type: string | null;
  floor: string | null;
  area: number | null;
  en: boolean;
}) {
  return (
    <span className="min-w-0 flex-1">
      {code ? (
        <bdi dir="ltr" className="font-mono font-medium">
          {code}
        </bdi>
      ) : (
        <span className="font-medium">{type ?? (en ? 'Unit' : 'وحدة')}</span>
      )}
      {/*
        Each number isolated: bidi runs across spans, and a floor «0» beside an
        area «120» otherwise reads «0120» in a right-to-left line.
      */}
      {floor ? (
        <span className="ms-2 text-xs text-muted-foreground">
          {en ? 'Floor ' : 'الطابق '}
          <bdi>{floor}</bdi>
        </span>
      ) : null}
      {area != null ? (
        <span className="ms-2 text-xs text-muted-foreground">
          <bdi>{area}</bdi> {en ? 'm²' : 'م²'}
        </span>
      ) : null}
    </span>
  );
}

/**
 * «من المالك الجديد؟» — a registered citizen found by search, or «ليس مسجَّلاً بعد».
 *
 * Search, not a select: the register holds thousands, and the officer has a
 * name, a phone or a reference number in front of them. The seller is never
 * offered. Nothing is chosen until the officer chooses — «not registered» is an
 * answer, not a default, because it opens a task somebody has to do.
 */
function BuyerPicker({
  tenant,
  token,
  sellerId,
  value,
  onChange,
  locale,
}: {
  tenant: string;
  token: string;
  sellerId: string;
  value: Buyer | null;
  onChange: (next: Buyer | null) => void;
  locale: string;
}) {
  const en = locale === 'en';
  const searchId = useId();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [searched, setSearched] = useState('');

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearched('');
      setSearching(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setFailed(false);
    const timer = setTimeout(() => {
      listCitizens(tenant, token, { search: trimmed, limit: 6 })
        .then((found) => {
          if (cancelled) return;
          setResults(found.items.filter((row) => row.id !== sellerId));
          setSearched(trimmed);
        })
        .catch((caught) => {
          logApiError(caught);
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, tenant, token, sellerId]);

  if (value?.kind === 'citizen') {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium">
          {en ? 'New owner' : 'المالك الجديد'} <span className="text-destructive">*</span>
        </p>
        <div className="flex min-h-11 items-center gap-3 rounded-md border border-primary bg-primary/10 px-3 py-2 text-sm">
          <UserRound className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium text-primary">{value.name}</span>
          <Button variant="ghost" size="sm" className="h-9 shrink-0" onClick={() => onChange(null)}>
            {en ? 'Change' : 'تغيير'}
          </Button>
        </div>
      </div>
    );
  }

  const unregistered = value?.kind === 'unregistered';

  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-sm font-medium">
        {en ? 'Who is the new owner?' : 'من المالك الجديد؟'} <span className="text-destructive">*</span>
      </legend>

      <div className="relative">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={searchId}
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            if (unregistered) onChange(null);
          }}
          placeholder={en ? 'Name, phone or reference number' : 'الاسم أو الهاتف أو الرقم المرجعي'}
          aria-label={en ? 'Search the register for the new owner' : 'ابحث في السجل عن المالك الجديد'}
          className="ps-9"
          autoComplete="off"
        />
        {searching ? (
          <Loader2
            className="absolute end-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </div>

      {failed ? (
        <p className="text-xs text-destructive">
          {en ? 'The search failed — check the connection, or choose «not registered yet».' : 'تعذّر البحث — تحقّق من الاتصال، أو اختر «ليس مسجَّلاً بعد».'}
        </p>
      ) : results.length > 0 ? (
        <ul className="grid gap-1.5" aria-label={en ? 'Matching citizens' : 'مواطنون مطابقون'}>
          {results.map((row) => {
            const name = row.fullName;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onChange({ kind: 'citizen', id: row.id, name })}
                  className="flex min-h-11 w-full items-center gap-3 rounded-md border px-3 py-2 text-start text-sm transition-colors duration-150 hover:bg-accent"
                >
                  <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{name}</span>
                    {/* The one thing that tells two «محمد خليل»s apart. */}
                    {row.motherName ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {en ? `Mother: ${row.motherName}` : `والدته: ${row.motherName}`}
                      </span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {row.phone ? (
                        <bdi dir="ltr" className="font-mono">
                          {row.phone}
                        </bdi>
                      ) : null}
                      {row.phone && row.referenceNumber ? ' · ' : null}
                      {row.referenceNumber ? (
                        <bdi dir="ltr" className="font-mono">
                          {row.referenceNumber}
                        </bdi>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : searched && !searching ? (
        <p className="text-xs text-muted-foreground">
          {en ? `Nobody on the register matches «${searched}».` : `لا أحد في السجل يطابق «${searched}».`}
        </p>
      ) : null}

      <button
        type="button"
        aria-pressed={unregistered}
        onClick={() => onChange(unregistered ? null : { kind: 'unregistered' })}
        className={cn(
          'min-h-11 w-full rounded-md border px-3 py-2.5 text-start text-sm transition-colors duration-150',
          unregistered ? 'border-primary bg-primary/10' : 'border-dashed hover:bg-accent',
        )}
      >
        <span className={cn('block font-medium', unregistered && 'text-primary')}>
          {en ? 'Not registered yet' : 'ليس مسجَّلاً بعد'}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {en
            ? 'A task is opened on the unit, and you can open a file for them straight after saving.'
            : 'تُفتح مهمة على الوحدة، ويمكنك فتح ملف له مباشرة بعد الحفظ.'}
        </span>
      </button>
    </fieldset>
  );
}

function uniqueTenants(list: readonly OwnershipLinkedTenant[]): OwnershipLinkedTenant[] {
  const seen = new Set<string>();
  return list.filter((tenant) => {
    if (seen.has(tenant.propertyEntryId)) return false;
    seen.add(tenant.propertyEntryId);
    return true;
  });
}
