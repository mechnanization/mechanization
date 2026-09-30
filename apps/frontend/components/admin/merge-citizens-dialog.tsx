'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, GitMerge, Loader2, TriangleAlert } from 'lucide-react';
import {
  getLabels,
  type CitizenMergePreview,
  type CitizenMergeResult,
  type CitizenMergeSide,
} from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, mergeCitizens, previewCitizenMerge } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * «دمج ملفين» — one person filed twice, folded into one file. SUPER_ADMIN only;
 * the server enforces it, and callers only render this for that role.
 *
 * ## Why the dialog is this long
 *
 * A merge rewrites whose a filing, a bill and a flat are. Everything it will do
 * is read from the server's own preview and laid out before the button — which
 * file stays, which filing becomes the file, which cards move, which flats end
 * as «سُجِّل خطأً» and whose pay that costs, which bill is left for the
 * accountant, and which fields disagree. The administrator confirms *that*, not
 * a summary of it: the merge is refused if either file moved since the preview.
 *
 * ## Which file stays
 *
 * The one registered first, by default — its reference is the one already
 * printed on the person's receipts, and its officer filed first. «بدّل» swaps
 * the two and asks the server again: the fields that fill, the flats that end
 * and the pay they cost all depend on the direction.
 *
 * ## The confirmation
 *
 * A reason (it goes on both files' trails and on the merge itself) and the
 * absorbed file's reference number typed back: the one step muscle memory
 * cannot do, on the one action here that would have merged three brothers.
 */
export function MergeCitizensDialog({
  open,
  onOpenChange,
  tenant,
  token,
  locale,
  firstId,
  secondId,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  locale: string;
  /** Either order — the file registered first is kept unless the administrator swaps. */
  firstId: string;
  secondId: string;
  onMerged: (result: CitizenMergeResult) => void;
}): React.JSX.Element {
  const en = locale === 'en';
  const [pair, setPair] = useState<{ keepId: string; absorbId: string }>({ keepId: firstId, absorbId: secondId });
  /** Set once the administrator has chosen — the automatic «oldest stays» never overrides them. */
  const [chosen, setChosen] = useState(false);
  const [preview, setPreview] = useState<CitizenMergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  /** Decided synchronously: `busy` disables the button only after a re-render. */
  const runningRef = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(
    async (next: { keepId: string; absorbId: string }, auto: boolean) => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await previewCitizenMerge(tenant, token, next);
        const keepAt = result.keep.registeredAt ? Date.parse(result.keep.registeredAt) : Infinity;
        const absorbAt = result.absorb.registeredAt ? Date.parse(result.absorb.registeredAt) : Infinity;
        if (auto && absorbAt < keepAt) {
          // The file registered first stays — asked again the other way round.
          const swapped = { keepId: next.absorbId, absorbId: next.keepId };
          setPair(swapped);
          setPreview(await previewCitizenMerge(tenant, token, swapped));
        } else {
          setPair(next);
          setPreview(result);
        }
      } catch (caught) {
        logApiError(caught);
        setPreview(null);
        setLoadError(
          caught instanceof ApiRequestError
            ? caught.message
            : en
              ? 'Could not load what the merge would do.'
              : 'تعذّر تحميل معاينة الدمج.',
        );
      } finally {
        setLoading(false);
      }
    },
    [tenant, token, en],
  );

  useEffect(() => {
    if (!open) return;
    setChosen(false);
    setReason('');
    setTyped('');
    setFailure(null);
    void load({ keepId: firstId, absorbId: secondId }, true);
  }, [open, firstId, secondId, load]);

  const swap = () => {
    setChosen(true);
    setTyped('');
    setFailure(null);
    void load({ keepId: pair.absorbId, absorbId: pair.keepId }, false);
  };

  const confirmText = preview ? (preview.absorb.referenceNumber ?? preview.absorb.fullName) : '';
  const reasonOk = reason.trim().length >= 10;
  const typedOk = typed.trim() === confirmText;
  const blocked = !preview || preview.blocks.length > 0 || loading;
  const ready = !blocked && reasonOk && typedOk && !busy;

  const run = async () => {
    if (!preview || !ready || runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await mergeCitizens(tenant, token, {
        keepId: preview.keep.id,
        absorbId: preview.absorb.id,
        reason: reason.trim(),
        expected: { keep: preview.keep.version, absorb: preview.absorb.version },
      });
      onMerged(result);
      onOpenChange(false);
    } catch (caught) {
      logApiError(caught);
      const stale =
        caught instanceof ApiRequestError &&
        (caught.payload.details as { code?: string } | undefined)?.code === 'STALE_PREVIEW';
      setFailure(
        caught instanceof ApiRequestError ? caught.message : en ? 'The merge failed.' : 'تعذّر الدمج.',
      );
      // Something moved: the preview on screen is no longer what would happen.
      if (stale) {
        setTyped('');
        void load(pair, false);
      }
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5 shrink-0 text-primary" aria-hidden />
            {en ? 'Merge two files' : 'دمج ملفين'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? 'For one person filed twice. The file that stays keeps its reference number; the other is deactivated and everything it held moves across.'
              : 'لشخص سُجِّل مرتين. الملف الباقي يحتفظ برقمه المرجعي، والآخر يُعطَّل وينتقل كل ما عليه إلى الملف الباقي.'}
          </DialogDescription>
        </DialogHeader>

        {loading && !preview ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {en ? 'Working out what the merge would do…' : 'جارٍ حساب ما سيفعله الدمج…'}
          </p>
        ) : null}

        {loadError ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">
            {loadError}
          </p>
        ) : null}

        {preview ? (
          <div className={cn('space-y-5 text-sm', loading && 'opacity-60')}>
            <Sides preview={preview} locale={locale} onSwap={swap} swapped={chosen} disabled={loading || busy} />

            {preview.blocks.length > 0 ? (
              <section className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="flex items-center gap-1.5 font-semibold text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {en ? 'This merge cannot go ahead yet' : 'لا يمكن إجراء هذا الدمج بعد'}
                </p>
                <ul className="list-disc space-y-1 ps-5 leading-relaxed">
                  {preview.blocks.map((block) => (
                    <li key={`${block.code}:${block.message}`}>{block.message}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <WhatHappens preview={preview} locale={locale} />
            <Fields preview={preview} locale={locale} />

            {preview.blocks.length === 0 ? (
              <section className="space-y-3 border-t pt-4">
                <div className="space-y-1.5">
                  <label htmlFor="merge-reason" className="font-medium">
                    {en ? 'Why are these one person?' : 'لماذا هما الشخص نفسه؟'}
                  </label>
                  <Textarea
                    id="merge-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={2}
                    maxLength={1000}
                    placeholder={
                      en
                        ? 'e.g. same name, mother and civil record; confirmed by phone with the family'
                        : 'مثلاً: الاسم واسم الأم ورقم السجل متطابقة، وتأكّدنا هاتفياً من العائلة'
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {en
                      ? 'Recorded on both files and on the merge.'
                      : 'يُسجَّل في سجل الملفين وفي سجل الدمج.'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="merge-confirm" className="font-medium">
                    {en ? 'Type the reference of the file that will be folded in:' : 'اكتب الرقم المرجعي للملف الذي سيُدمج:'}{' '}
                    <span dir="ltr" className="font-semibold">
                      {confirmText}
                    </span>
                  </label>
                  <Input
                    id="merge-confirm"
                    dir="ltr"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={typed.trim().length > 0 && !typedOk}
                  />
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {failure ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">
            {failure}
          </p>
        ) : null}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="w-full sm:w-auto">
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button onClick={() => void run()} disabled={!ready} className="w-full sm:w-auto">
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <GitMerge className="size-4" aria-hidden />
            )}
            {busy ? (en ? 'Merging…' : 'جارٍ الدمج…') : en ? 'Merge the two files' : 'ادمج الملفين'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────  Parts  ─────────────────────────────

function SideCard({ side, role, locale }: { side: CitizenMergeSide; role: 'keep' | 'absorb'; locale: string }) {
  const en = locale === 'en';
  return (
    <div
      className={cn(
        'min-w-0 flex-1 space-y-1 rounded-lg border p-3',
        role === 'keep' ? 'border-primary/40 bg-primary/5' : 'border-dashed bg-muted/30',
      )}
    >
      <Badge variant={role === 'keep' ? 'soft-default' : 'soft-muted'}>
        {role === 'keep' ? (en ? 'Stays' : 'يبقى') : en ? 'Folded in, deactivated' : 'يُدمج ويُعطَّل'}
      </Badge>
      <p className="truncate font-semibold">{side.fullName}</p>
      <p className="text-xs text-muted-foreground">
        <span dir="ltr">{side.referenceNumber ?? '—'}</span>
        {side.registeredAt ? ` · ${formatDate(side.registeredAt)}` : ''}
      </p>
      <p className="text-xs text-muted-foreground">
        {side.motherName ? `${en ? 'Mother' : 'الأم'}: ${side.motherName}` : null}
        {side.phone ? (
          <>
            {side.motherName ? ' · ' : ''}
            <span dir="ltr">{side.phone}</span>
          </>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {en
          ? `${side.registrations} filing(s), ${side.currentCards} current card(s)`
          : `طلبات التسجيل: ${side.registrations} · بطاقات حالية: ${side.currentCards}`}
      </p>
    </div>
  );
}

function Sides({
  preview,
  locale,
  onSwap,
  swapped,
  disabled,
}: {
  preview: CitizenMergePreview;
  locale: string;
  onSwap: () => void;
  swapped: boolean;
  disabled: boolean;
}) {
  const en = locale === 'en';
  return (
    <section className="space-y-2">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <SideCard side={preview.keep} role="keep" locale={locale} />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 self-center"
          onClick={onSwap}
          disabled={disabled}
        >
          <ArrowLeftRight className="size-4" aria-hidden />
          {en ? 'Swap' : 'بدّل'}
        </Button>
        <SideCard side={preview.absorb} role="absorb" locale={locale} />
      </div>
      {!swapped ? (
        <p className="text-xs text-muted-foreground">
          {en
            ? 'The file registered first stays by default: its reference is the one on the person’s receipts.'
            : 'يبقى افتراضياً الملف المسجَّل أولاً: رقمه المرجعي هو المطبوع على إيصالات الشخص.'}
        </p>
      ) : null}
    </section>
  );
}

function Line({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'warn' }) {
  return (
    <li className={cn('leading-relaxed', tone === 'warn' && 'text-warning')}>{children}</li>
  );
}

function WhatHappens({ preview, locale }: { preview: CitizenMergePreview; locale: string }) {
  const en = locale === 'en';
  const { counts } = preview;
  const moved = preview.cardsMoved;

  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{en ? 'What the merge does' : 'ما سيفعله الدمج'}</h3>
      <ul className="list-disc space-y-1 ps-5">
        {preview.newestFiling.id ? (
          <Line>
            {en ? 'The file becomes filing ' : 'يصبح الملفَّ طلبُ التسجيل '}
            <span dir="ltr" className="font-medium">
              {preview.newestFiling.referenceNumber}
            </span>
            {en
              ? ' — the newest of both, the one billing and the edit form read.'
              : ' — الأحدث بين الملفين، وهو ما تقرؤه الفوترة ونموذج التعديل.'}
          </Line>
        ) : null}
        {counts.registrations > 0 ? (
          <Line>
            {en
              ? `${counts.registrations} filing(s) move to the file that stays.`
              : `ينتقل ${counts.registrations} من طلبات التسجيل إلى الملف الباقي.`}
          </Line>
        ) : null}
        {moved.length > 0 ? (
          <Line>
            {en ? 'Cards moved onto that filing: ' : 'بطاقات تنتقل إلى ذلك الطلب: '}
            {moved.map((card, index) => (
              <span key={card.cardId}>
                {index > 0 ? '، ' : ''}
                {card.label}
                {card.unitCodes.length > 0 ? (
                  <span dir="ltr" className="text-muted-foreground">
                    {' '}
                    ({card.unitCodes.join(', ')})
                  </span>
                ) : null}
                {card.unlinked ? (
                  <span className="text-muted-foreground">
                    {en ? ' — not linked to the census, check it after' : ' — غير مرتبطة بسجل المباني، راجعها بعد الدمج'}
                  </span>
                ) : null}
              </span>
            ))}
            {en ? '. Each keeps crediting the officer who filed it.' : '. وتبقى كل بطاقة محسوبة للموظف الذي سجّلها.'}
          </Line>
        ) : null}
        {preview.duplicates.length > 0 ? (
          <Line tone="warn">
            {en ? 'Recorded on both files — the copy on the folded file ends as «recorded in error»: ' : 'مسجَّلة في الملفين — تُنهى نسخة الملف المدموج بسبب «سُجِّل خطأً»: '}
            {preview.duplicates.map((duplicate, index) => (
              <span key={`${duplicate.label}:${index}`}>
                {index > 0 ? '، ' : ''}
                <span dir="ltr">{duplicate.unitCode ?? duplicate.label}</span>
                {duplicate.filedBy ? (en ? ` (filed by ${duplicate.filedBy})` : ` (سجّلها ${duplicate.filedBy})`) : ''}
              </span>
            ))}
          </Line>
        ) : null}
        {preview.pay.map((line) => (
          <Line key={line.officerId} tone="warn">
            {en
              ? `${line.officerName}'s earnings change by ${line.delta} $ — a duplicate copy is not paid twice.`
              : `يتغيّر مستحق ${line.officerName} بمقدار ${line.delta} $ — النسخة المكررة لا تُحتسب مرتين.`}
          </Line>
        ))}
        {counts.spellsMoved > 0 ? (
          <Line>
            {en
              ? `${counts.spellsMoved} census occupancy record(s) move across${counts.spellsEnded > 0 ? `, ${counts.spellsEnded} of them ended as duplicates` : ''}.`
              : `ينتقل ${counts.spellsMoved} من سجلات الإشغال في سجل المباني${counts.spellsEnded > 0 ? `، ويُنهى ${counts.spellsEnded} منها لأنها مكررة` : ''}.`}
          </Line>
        ) : null}
        {counts.bills + counts.checkouts > 0 ? (
          <Line>
            {en ? `${counts.bills} bill(s) move to the file that stays.` : `تنتقل ${counts.bills} من الفواتير إلى الملف الباقي.`}
          </Line>
        ) : null}
        {preview.billsLeftBehind.length > 0 ? (
          <Line tone="warn">
            {en
              ? 'Billed on both files for the same fee and period — left untouched on the folded file for the accountant: '
              : 'فواتير صدرت على الملفين للرسم والفترة نفسيهما — تبقى على الملف المدموج دون تعديل ليراجعها المحاسب: '}
            {preview.billsLeftBehind.map((bill, index) => (
              <span key={bill.paymentId}>
                {index > 0 ? '، ' : ''}
                {bill.title} ({bill.periodKey}) {bill.amount.toLocaleString('en-US')} {bill.currency}
              </span>
            ))}
          </Line>
        ) : null}
        {counts.tenantLinks > 0 ? (
          <Line>
            {en
              ? `${counts.tenantLinks} tenant card(s) that name the folded file as landlord now name the file that stays.`
              : `${counts.tenantLinks} من بطاقات المستأجرين التي تسمّي الملف المدموج مالكاً تصبح تسمّي الملف الباقي.`}
          </Line>
        ) : null}
        {counts.cases + counts.feeNotices > 0 ? (
          <Line>
            {en
              ? `${counts.cases} case(s) and ${counts.feeNotices} individual fee notice(s) follow the person.`
              : `تنتقل ${counts.cases} من الحالات و${counts.feeNotices} من الرسوم الفردية مع الشخص.`}
          </Line>
        ) : null}
        {counts.flagsAnswered > 0 ? (
          <Line>
            {en
              ? '«Possible existing record» is answered by this merge and cleared.'
              : 'تُجاب ملاحظة «سجل مشابه موجود» بهذا الدمج وتُزال.'}
          </Line>
        ) : null}
      </ul>
    </section>
  );
}

function Fields({ preview, locale }: { preview: CitizenMergePreview; locale: string }) {
  const en = locale === 'en';
  const labels = getLabels(locale).citizenField as Record<string, string>;
  const name = (field: string) =>
    field === 'residence' ? (en ? 'Record type' : 'نوع الملف') : (labels[field] ?? field);

  if (preview.fills.length === 0 && preview.conflicts.length === 0) return null;

  return (
    <section className="space-y-3">
      {preview.fills.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-semibold">{en ? 'Filled in from the folded file' : 'يُكمَل من الملف المدموج'}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {preview.fills.map((fill) => (
              <li key={fill.field} className="rounded-md border bg-muted/30 px-2 py-1 text-xs">
                <span className="text-muted-foreground">{name(fill.field)}: </span>
                {/* `auto`: an Arabic name reads right to left, a phone or a number left to right. */}
                <span dir="auto">{fill.value ?? '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.conflicts.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-semibold">
            {en ? 'Answered differently — the file that stays keeps its own' : 'مختلفان — يبقى جواب الملف الباقي'}
          </h3>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-start font-medium">{en ? 'Field' : 'الحقل'}</th>
                  <th className="px-2 py-1.5 text-start font-medium">{en ? 'Stays' : 'يبقى'}</th>
                  <th className="px-2 py-1.5 text-start font-medium">
                    {en ? 'Kept only on the folded file' : 'يبقى على الملف المدموج فقط'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.conflicts.map((conflict) => (
                  <tr key={conflict.field} className="border-t">
                    <td className="px-2 py-1.5 text-muted-foreground">{name(conflict.field)}</td>
                    <td className="px-2 py-1.5 font-medium">
                      <span dir="auto">{conflict.keep}</span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground line-through decoration-muted-foreground/50">
                      <span dir="auto">{conflict.absorb}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {en
              ? 'If the other answer is the right one, press «Swap», or correct the file after merging.'
              : 'إن كان الجواب الآخر هو الصحيح فاضغط «بدّل»، أو صحّح الملف بعد الدمج.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
