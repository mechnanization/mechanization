'use client';

import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert, Unlink } from 'lucide-react';
import {
  ApiRequestError,
  getLandlordUnlinkPreview,
  logApiError,
  unlinkLandlord,
  type UnlinkPreview,
  type UnlinkResult,
} from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/dates';

/**
 * «إلغاء الربط» — the one way to release a tenant card's owner fields.
 *
 * Opened from the tenant's file, the owner's file, and the tenant's edit form,
 * so the consequence is stated the same way wherever somebody meets the lock.
 * It reads what the undo would do *before* offering the button: which flats
 * leave the owner's file, whether a card the link created goes with them, and
 * whether bills have been raised on the owner since — which the undo does not
 * touch, and which somebody may need to cancel by hand.
 */
export function LandlordUnlinkDialog({
  tenant,
  token,
  propertyEntryId,
  open,
  onOpenChange,
  onUnlinked,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  propertyEntryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnlinked: (result: UnlinkResult) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const toast = useToast();
  const [preview, setPreview] = useState<UnlinkPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setLoadError(null);
      setFailure(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    getLandlordUnlinkPreview(tenant, token, propertyEntryId)
      .then((found) => {
        if (!controller.signal.aborted) setPreview(found);
      })
      .catch((caught) => {
        logApiError(caught);
        if (!controller.signal.aborted) {
          setLoadError(en ? 'Could not read what the undo would change.' : 'تعذّر قراءة ما سيغيّره الإلغاء.');
        }
      });
    return () => controller.abort();
  }, [open, tenant, token, propertyEntryId, en]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await unlinkLandlord(tenant, token, propertyEntryId);
      onOpenChange(false);
      onUnlinked(result);

      if (result.legacy) {
        toast.warning(en ? 'Link undone — check the units by hand' : 'أُلغي الربط — راجع الوحدات يدوياً', {
          description: en
            ? 'This link was made before links recorded what they added. Nothing on the owner’s file was removed; check the units on the building matrix.'
            : 'هذا الربط أُنشئ قبل أن تُحفظ تفاصيل ما يضيفه، فلم يُحذف شيء من ملف المالك. راجع الوحدات في مصفوفة المبنى.',
          duration: 12000,
        });
      } else if (result.kept.length > 0) {
        toast.warning(en ? 'Link undone — some records were kept' : 'أُلغي الربط — وبقيت بعض السجلات', {
          description: en
            ? 'They were changed after the link, or another tenant’s link still uses them. Review the owner’s file.'
            : 'عُدِّلت بعد الربط، أو يعتمد عليها ربط مستأجر آخر. راجع ملف المالك.',
          duration: 10000,
        });
      } else {
        toast.success(en ? 'Link undone' : 'أُلغي الربط', {
          description: en
            ? 'The claim is back on «Owner links», and what the link added to the owner’s file was removed.'
            : 'عادت المطالبة إلى «روابط المالكين»، وأُزيل ما أضافه الربط إلى ملف المالك.',
        });
      }
    } catch (caught) {
      logApiError(caught);
      setFailure(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not undo the link.'
            : 'تعذّر إلغاء الربط.',
      );
      setBusy(false);
    }
  };

  const units = preview?.unitCodes ?? [];

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <Unlink className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>
                {preview?.ownerName
                  ? en
                    ? `Undo the link to ${preview.ownerName}?`
                    : `إلغاء ربط ${preview.ownerName}؟`
                  : en
                    ? 'Undo this owner link?'
                    : 'إلغاء ربط المالك؟'}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? 'Use this when the wrong person was linked, or the tenant named someone else.'
                  : 'استخدم هذا إذا رُبط الشخص الخطأ، أو كان المستأجر يقصد شخصاً آخر.'}
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
            {en ? 'Reading what the undo would change…' : 'جارٍ قراءة ما سيغيّره الإلغاء…'}
          </p>
        ) : !preview.linked ? (
          <p className="text-sm text-muted-foreground">
            {en ? 'This card is no longer linked.' : 'هذه البطاقة لم تعد مربوطة.'}
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <ul className="list-disc space-y-1.5 ps-5 leading-relaxed">
              <li>
                {en
                  ? 'The owner field on the tenant’s card unlocks and shows what the tenant said again.'
                  : 'تُفتح خانة المالك في بطاقة المستأجر ويعود فيها ما ذكره المستأجر.'}
              </li>
              {preview.legacy ? (
                <li>
                  {en
                    ? 'This link was made before links recorded what they added, so nothing on the owner’s file is removed automatically.'
                    : 'هذا الربط أُنشئ قبل حفظ تفاصيل ما يضيفه، فلن يُحذف شيء من ملف المالك تلقائياً.'}
                </li>
              ) : (
                <>
                  {units.length > 0 ? (
                    <li>
                      {en ? 'The owner is taken off ' : 'يُزال المالك عن '}
                      {units.length === 1 ? (en ? 'unit ' : 'الوحدة ') : en ? 'units ' : 'الوحدات '}
                      <bdi dir="ltr" className="font-mono">
                        {units.join(', ')}
                      </bdi>
                      {en ? ', recorded as «recorded in error».' : '، ويُسجَّل ذلك «سُجِّل بالخطأ».'}
                    </li>
                  ) : null}
                  {preview.cardsCreated > 0 ? (
                    <li>
                      {en
                        ? 'The property card the link created on the owner’s file is removed.'
                        : 'تُحذف بطاقة العقار التي أنشأها الربط في ملف المالك.'}
                    </li>
                  ) : null}
                  <li>
                    {en
                      ? 'Anything somebody edited after the link is kept, and you are told.'
                      : 'ما عدّله أحد بعد الربط يبقى، وستُبلَّغ به.'}
                  </li>
                </>
              )}
              <li>
                {en
                  ? 'The claim goes back to «Owner links» to be answered again.'
                  : 'تعود المطالبة إلى «روابط المالكين» ليُجاب عنها من جديد.'}
              </li>
            </ul>

            {preview.invoicesSinceLink > 0 ? (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {en
                    ? `${preview.invoicesSinceLink} bill(s) were issued to the owner since ${
                        preview.linkedAt ? formatDate(preview.linkedAt) : 'the link'
                      }. They are not changed — review them on the owner’s file.`
                    : `صدرت ${preview.invoicesSinceLink} فاتورة للمالك منذ ${
                        preview.linkedAt ? formatDate(preview.linkedAt) : 'الربط'
                      }. لن تتغيّر — راجعها في ملف المالك.`}
                </span>
              </p>
            ) : null}
          </div>
        )}

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
            {en ? 'Keep the link' : 'إبقاء الربط'}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void run()}
            disabled={busy || !preview?.linked}
            className="h-11 w-full transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none sm:h-10 sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Unlink className="size-4" aria-hidden />}
            {en ? 'Undo the link' : 'إلغاء الربط'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
