'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Hash, Loader2, MapPinOff } from 'lucide-react';
import {
  ApiRequestError,
  correctBuildingParcel,
  duplicateBuildingsOf,
  getParcelCorrectionPreview,
  logApiError,
  type DuplicateBuildingCandidate,
  type ParcelCorrectionPreview,
  type ParcelCorrectionResult,
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const PREVIEW_DEBOUNCE_MS = 400;

/**
 * «تصحيح رقم العقار» — the building was filed under the wrong parcel.
 *
 * Not a move, and the dialog says so first: the structure keeps its units, its
 * occupants and its history, and takes the code the right parcel gives it.
 * Everything else is read from the server's dry run for the number typed
 * (`getParcelCorrectionPreview`) before anything is asked:
 *
 *  - the code, old → new, and that the old one stays findable and is never
 *    given to another building;
 *  - what the cadastre knows — an unknown parcel, a different sector, a pin
 *    outside the right parcel's outline — said, not refused;
 *  - structures already on the right parcel: the one question that has to be
 *    answered, because correcting a building onto its own duplicate makes two
 *    records of one structure;
 *  - which citizen cards and cases follow the number, which do not, and why.
 *
 * The reason is required: anyone who can edit the building can correct it,
 * and the reason is what the audit row and the retired code keep.
 */
export function ParcelCorrectionDialog({
  tenant,
  token,
  building,
  open,
  onOpenChange,
  onCorrected,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  building: { id: string; code: string; parcelNumber: string; updatedAt: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCorrected: (result: ParcelCorrectionResult) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const toast = useToast();
  const parcelId = useId();
  const reasonId = useId();
  const params = useParams<{ tenant?: string; locale?: string; adminPath?: string }>();
  const base =
    params?.tenant && params?.locale && params?.adminPath
      ? `/${params.tenant}/${params.locale}/${params.adminPath}`
      : null;

  const [parcel, setParcel] = useState('');
  const [preview, setPreview] = useState<ParcelCorrectionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [neighbours, setNeighbours] = useState<DuplicateBuildingCandidate[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [keepOld, setKeepOld] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const typed = parcel.trim();
  const sameNumber = typed !== '' && typed === building.parcelNumber;

  useEffect(() => {
    if (open) return;
    setParcel('');
    setPreview(null);
    setPreviewing(false);
    setPreviewError(null);
    setNeighbours([]);
    setAcknowledged(false);
    setKeepOld(false);
    setReason('');
    setBusy(false);
    setFailure(null);
  }, [open]);

  // The dry run for the number typed — debounced, and the answer to an older number discarded.
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPreviewError(null);
    setNeighbours([]);
    setAcknowledged(false);
    setFailure(null);
    if (!typed || sameNumber) {
      setPreviewing(false);
      return;
    }
    const controller = new AbortController();
    setPreviewing(true);
    const timer = setTimeout(() => {
      getParcelCorrectionPreview(tenant, token, building.id, typed, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setPreview(found);
          setNeighbours(found.neighbours);
        })
        .catch((caught) => {
          if (controller.signal.aborted) return;
          logApiError(caught);
          setPreviewError(
            caught instanceof ApiRequestError
              ? caught.payload.message
              : en
                ? 'Could not check this parcel number.'
                : 'تعذّر التحقق من رقم العقار.',
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, typed, sameNumber, tenant, token, building.id, en]);

  const reasonOk = reason.trim().length >= 3;
  const ready =
    Boolean(preview) &&
    !previewing &&
    reasonOk &&
    (neighbours.length === 0 || acknowledged) &&
    !busy;

  const run = async () => {
    if (!preview || !ready) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await correctBuildingParcel(tenant, token, building.id, {
        parcelNumber: preview.next.parcelNumber,
        reason: reason.trim(),
        ...(neighbours.length > 0 ? { acknowledgedDuplicates: true } : {}),
        ...(keepOld ? { keepOldAsShared: true } : {}),
        ...(building.updatedAt ? { expectedUpdatedAt: building.updatedAt } : {}),
      });
      toast.success(
        en
          ? `Parcel corrected: ${result.previousCode} is now ${result.building.code}` +
              (result.cardsCorrected > 0 ? `; ${result.cardsCorrected} citizen card(s) followed` : '')
          : `صُحِّح رقم العقار: ${result.previousCode} أصبح ${result.building.code}` +
              (result.cardsCorrected > 0 ? `، وتبعته ${result.cardsCorrected} بطاقة` : ''),
      );
      onOpenChange(false);
      onCorrected(result);
    } catch (caught) {
      logApiError(caught);
      // A structure appeared on the right parcel since the preview: ask about it here.
      const candidates = duplicateBuildingsOf(caught);
      if (candidates) {
        setNeighbours(candidates.filter((row) => row.id !== building.id));
        setAcknowledged(false);
      }
      setFailure(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not correct the parcel number.'
            : 'تعذّر تصحيح رقم العقار.',
      );
      setBusy(false);
    }
  };

  const mono = (value: string) => (
    <bdi dir="ltr" className="font-mono">
      {value}
    </bdi>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-lg" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <Hash className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>{en ? 'Correct the parcel number' : 'تصحيح رقم العقار'}</DialogTitle>
              <DialogDescription>
                {en ? 'Building ' : 'المبنى '}
                {mono(building.code)}
                {en ? ' is filed under parcel ' : ' مسجَّل على العقار '}
                {mono(building.parcelNumber)}
                {en
                  ? '. Correcting it does not move it: its units, occupants and history stay, and it takes the code of the right parcel.'
                  : '. التصحيح لا ينقل المبنى: تبقى وحداته وسكانه وسجلّه، ويأخذ رمزاً من العقار الصحيح.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <Field label={en ? 'The correct parcel number' : 'رقم العقار الصحيح'} htmlFor={parcelId} required>
            <div className="relative" dir="ltr">
              <Input
                id={parcelId}
                value={parcel}
                onChange={(event) => setParcel(event.target.value)}
                dir="ltr"
                inputMode="numeric"
                autoComplete="off"
                placeholder={building.parcelNumber}
                className="pe-9 text-start font-mono text-base font-medium"
                aria-describedby={`${parcelId}-state`}
              />
              {previewing ? (
                <Loader2
                  className="absolute end-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : null}
            </div>
            <div id={`${parcelId}-state`} aria-live="polite">
              {sameNumber ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {en ? 'This is the number it already has.' : 'هذا هو رقمه الحالي.'}
                </p>
              ) : previewError ? (
                <p role="alert" className="mt-1.5 text-xs text-destructive">
                  {previewError}
                </p>
              ) : preview?.cadastre.known === true ? (
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-success">
                  <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                  {en ? 'In the cadastre' : 'موجود في المسح العقاري'}
                </p>
              ) : preview?.cadastre.known === false ? (
                <p className="mt-1.5 inline-flex items-start gap-1.5 text-xs font-medium text-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {en
                    ? 'Not in the cadastre. It can still be used — check the property deed (الصحيفة العقارية) first.'
                    : 'غير موجود في المسح العقاري. يمكن التصحيح رغم ذلك — راجع الصحيفة العقارية أولاً.'}
                </p>
              ) : null}
            </div>
          </Field>

          {preview ? (
            <>
              {/* ── The code, old → new ── */}
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {en ? 'Building code' : 'رمز المبنى'}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-base font-bold" dir="ltr">
                  <span className="font-mono text-muted-foreground line-through decoration-1">{preview.building.code}</span>
                  <ArrowLeft className="size-4 rotate-180 text-muted-foreground" aria-hidden />
                  <span className="font-mono text-foreground">{preview.next.code}</span>
                </p>
                {preview.next.reclaimsOwnCode ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {en ? 'Its own code from before — it had been corrected away from this parcel.' : 'رمزه السابق نفسه — كان قد صُحِّح بعيداً عن هذا العقار.'}
                  </p>
                ) : null}
                {preview.next.zoneChanged ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {en ? 'Sector: ' : 'القطاع: '}
                    {preview.building.zoneName ?? (en ? 'none' : 'بلا قطاع')}
                    {' ← '}
                    {preview.next.zoneName ?? (en ? 'none' : 'بلا قطاع')}
                  </p>
                ) : null}
              </div>

              {preview.cadastre.pinInside === false ? (
                <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed text-foreground">
                  <MapPinOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  {en
                    ? `The entrance pin is outside parcel ${preview.next.parcelNumber}'s outline. It is kept — check it on the map after correcting.`
                    : `دبوس المدخل خارج حدود العقار ${preview.next.parcelNumber}. يبقى كما هو — تحقّق منه على الخريطة بعد التصحيح.`}
                </p>
              ) : null}

              {preview.next.wasSharedParcel ? (
                <p className="rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
                  {en
                    ? `Parcel ${preview.next.parcelNumber} is listed as one of this building's shared parcels; it becomes its own parcel.`
                    : `العقار ${preview.next.parcelNumber} مسجَّل عقاراً مشتركاً لهذا المبنى، ويصبح عقاره الأساسي.`}
                </p>
              ) : null}

              {/* ── Structures already on the right parcel ── */}
              {neighbours.length > 0 ? (
                <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <p className="flex items-start gap-2 font-medium text-warning">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {en
                      ? `Parcel ${preview.next.parcelNumber} already has ${neighbours.length === 1 ? 'a building' : `${neighbours.length} buildings`}`
                      : `على العقار ${preview.next.parcelNumber} ${neighbours.length === 1 ? 'مبنى مسجَّل' : `${neighbours.length} مبانٍ مسجَّلة`} مسبقاً`}
                  </p>
                  <ul className="space-y-1.5">
                    {neighbours.map((row) => (
                      <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground">
                        <span className="font-mono font-medium" dir="ltr">
                          {row.code}
                        </span>
                        {row.name ? <span>{row.name}</span> : null}
                        <span className="text-muted-foreground">
                          {en ? `${row.unitsTotal} units` : `${row.unitsTotal} وحدة`}
                          {row.distanceMetres != null ? (en ? ` · ${row.distanceMetres} m away` : ` · على بُعد ${row.distanceMetres} م`) : ''}
                        </span>
                        {base ? (
                          <Link
                            href={`${base}/buildings/${encodeURIComponent(row.id)}/matrix`}
                            target="_blank"
                            rel="noopener"
                            className="inline-flex min-h-8 items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                          >
                            {en ? 'Open' : 'فتح'}
                            <ExternalLink className="size-3" aria-hidden />
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs leading-relaxed text-foreground">
                    {en
                      ? 'If this building is one of them, it is a duplicate record: do not correct the number — merge the duplicate instead.'
                      : 'إن كان هذا المبنى أحدها فهو سجل مكرَّر: لا تصحّح الرقم، بل عالج التكرار.'}
                  </p>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-warning/40 bg-background px-3 py-2 text-sm">
                    <Checkbox
                      checked={acknowledged}
                      onCheckedChange={(value) => setAcknowledged(value === true)}
                      className="size-5"
                    />
                    <span>
                      {en ? 'I checked: this building is none of them' : 'تحقّقتُ: هذا المبنى ليس أياً منها'}
                    </span>
                  </label>
                </div>
              ) : null}

              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm hover:bg-accent">
                <Checkbox
                  checked={keepOld}
                  onCheckedChange={(value) => setKeepOld(value === true)}
                  className="mt-0.5 size-5"
                />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {en ? 'It also stands on parcel ' : 'يقوم المبنى على العقار '}
                    {mono(preview.building.parcelNumber)}
                    {en ? ' — keep it as a shared parcel' : ' أيضاً — أبقِه عقاراً مشتركاً'}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {en
                      ? 'Only if the building really straddles both. Citizen cards naming the old number then stay as they are.'
                      : 'فقط إن كان المبنى يمتد على العقارين فعلاً. تبقى عندها بطاقات المواطنين التي تذكر الرقم القديم كما هي.'}
                  </span>
                </span>
              </label>

              {/* ── What will happen ── */}
              <div className="rounded-md bg-muted/40 p-3">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{en ? 'What will happen' : 'ماذا سيحدث'}</p>
                <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed">
                  <li>
                    {en ? 'The old code ' : 'يبقى الرمز القديم '}
                    {mono(preview.building.code)}
                    {en
                      ? ' still finds this building in search, and is never given to another building.'
                      : ' يدلّ على هذا المبنى في البحث، ولا يُعطى لمبنى آخر أبداً.'}
                  </li>
                  {keepOld ? (
                    <li>
                      {en ? 'Citizen cards naming ' : 'تبقى بطاقات المواطنين التي تذكر العقار '}
                      {mono(preview.building.parcelNumber)}
                      {en ? ' stay as they are.' : ' كما هي.'}
                    </li>
                  ) : preview.cards.toRewrite > 0 ? (
                    <li>
                      {en
                        ? `The parcel number is corrected on ${preview.cards.toRewrite} citizen card(s) of ${preview.cards.citizenCount} citizen(s)`
                        : `يُصحَّح رقم العقار في ${preview.cards.toRewrite} بطاقة لـ${preview.cards.citizenCount} مواطن`}
                      {preview.cards.toRewrite > preview.cards.current
                        ? en
                          ? `, ${preview.cards.toRewrite - preview.cards.current} of them ended`
                          : `، منها ${preview.cards.toRewrite - preview.cards.current} منتهية`
                        : ''}
                      {preview.cards.citizens.length > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {preview.cards.citizens.map((row) => row.name).join('، ')}
                          {preview.cards.citizenCount > preview.cards.citizens.length
                            ? en
                              ? ` and ${preview.cards.citizenCount - preview.cards.citizens.length} more`
                              : ` و${preview.cards.citizenCount - preview.cards.citizens.length} غيرهم`
                            : ''}
                        </span>
                      ) : null}
                    </li>
                  ) : (
                    <li>{en ? 'No citizen card names the old number.' : 'لا توجد بطاقة مواطن تذكر الرقم القديم.'}</li>
                  )}
                  {!keepOld && preview.cases > 0 ? (
                    <li>
                      {en
                        ? `The number is corrected on ${preview.cases} case(s) about this building.`
                        : `يُصحَّح الرقم في ${preview.cases} حالة متابعة عن هذا المبنى.`}
                    </li>
                  ) : null}
                  {preview.cards.underSharedParcel > 0 ? (
                    <li className="text-muted-foreground">
                      {en
                        ? `${preview.cards.underSharedParcel} card(s) filed under one of its shared parcels stay as they are.`
                        : `${preview.cards.underSharedParcel} بطاقة مسجَّلة على أحد عقاراته المشتركة تبقى كما هي.`}
                    </li>
                  ) : null}
                  {preview.cards.otherNumber > 0 ? (
                    <li className="text-muted-foreground">
                      {en
                        ? `${preview.cards.otherNumber} card(s) linked to it name another number — left as they are; review them.`
                        : `${preview.cards.otherNumber} بطاقة مرتبطة به تذكر رقماً آخر — تبقى كما هي، فراجعها.`}
                    </li>
                  ) : null}
                  {preview.unlinkedOnOldParcel > 0 ? (
                    <li className="text-muted-foreground">
                      {en
                        ? `${preview.unlinkedOnOldParcel} card(s) not linked to any building name parcel ${preview.building.parcelNumber} — not changed, they may be another property there.`
                        : `${preview.unlinkedOnOldParcel} بطاقة غير مرتبطة بأي مبنى تذكر العقار ${preview.building.parcelNumber} — لا تتغيّر، فقد تخصّ عقاراً آخر فعلاً.`}
                    </li>
                  ) : null}
                  {preview.unlinkedOnNewParcel > 0 ? (
                    <li className="text-muted-foreground">
                      {en
                        ? `${preview.unlinkedOnNewParcel} card(s) not linked to any building name parcel ${preview.next.parcelNumber} — they may be this building; link them from their holder's file.`
                        : `${preview.unlinkedOnNewParcel} بطاقة غير مرتبطة تذكر العقار ${preview.next.parcelNumber} — قد تخصّ هذا المبنى؛ اربطها به من ملف صاحبها.`}
                    </li>
                  ) : null}
                  <li className="text-muted-foreground">
                    {en
                      ? 'No bill amount changes: the parcel number is not part of any fee. Bills already issued keep what they were issued with.'
                      : 'لا يتغيّر مبلغ أي فاتورة: رقم العقار لا يدخل في حساب الرسوم، والفواتير الصادرة تبقى كما صدرت.'}
                  </li>
                </ul>
              </div>

              <Field label={en ? 'Reason for the correction' : 'سبب التصحيح'} htmlFor={reasonId} required>
                <Textarea
                  id={reasonId}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder={
                    en
                      ? `e.g. the property deed says ${preview.next.parcelNumber}, not ${preview.building.parcelNumber}`
                      : `مثال: الصحيفة العقارية تذكر ${preview.next.parcelNumber} لا ${preview.building.parcelNumber}`
                  }
                  aria-describedby={`${reasonId}-help`}
                />
                <p id={`${reasonId}-help`} className="mt-1 text-xs text-muted-foreground">
                  {en
                    ? 'Required. Kept with the retired code and in the audit trail, under your name.'
                    : 'مطلوب. يُحفظ مع الرمز القديم وفي سجل التدقيق باسمك.'}
                </p>
              </Field>
            </>
          ) : null}

          {failure ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
              {failure}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-11 w-full sm:h-10 sm:w-auto">
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void run()}
            disabled={!ready}
            className={cn(
              'h-11 w-full transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none sm:h-10 sm:w-auto',
            )}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Hash className="size-4" aria-hidden />}
            {en ? 'Correct the parcel number' : 'تصحيح رقم العقار'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
