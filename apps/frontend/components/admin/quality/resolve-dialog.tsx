'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { QualityFinding } from '@/lib/quality-api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { FindingDetail } from './finding-parts';

/**
 * «تم الحل» — and the reason, which is the only part of a finding that is ever
 * stored.
 *
 * A finding is recomputed from the register on every read, so a record that was
 * actually corrected drops out of the queue by itself. What this writes is the
 * other case: two genuine neighbours four metres apart, two cousins with one
 * name and one household phone — a standing answer that stops the scan asking
 * again. The dialog says so plainly, because a reviewer who presses it on a
 * record they mean to fix later has silenced the reminder, not fixed anything.
 *
 * The reason is required by the server (four characters), and required for a
 * better reason than validation: it is what the next reviewer reads instead of
 * re-deciding the same pair.
 */
export function ResolveDialog({
  finding,
  title,
  locale,
  open,
  onOpenChange,
  onConfirm,
}: {
  finding: QualityFinding | null;
  /** The finding's own headline, already localised by the caller. */
  title: string;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Awaited — the dialog stays open and busy until it settles. */
  onConfirm: (reason: string) => Promise<void>;
}): React.JSX.Element {
  const en = locale === 'en';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setReason('');
      setFailure(null);
    }
    onOpenChange(next);
  };

  const run = async () => {
    if (reason.trim().length < 4 || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(reason.trim());
      setReason('');
      onOpenChange(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : en ? 'Not saved.' : 'لم يُحفظ.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <DialogTitle>{en ? 'Mark as resolved' : 'تعليم الملاحظة «تم الحل»'}</DialogTitle>
          <DialogDescription>
            {en
              ? 'This clears the finding from the queue and stores your reason against it.'
              : 'يرفع هذا الملاحظة من القائمة ويحفظ سببك معها.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-semibold">{title}</p>
            {finding ? (
              <FindingDetail detail={finding.detail} locale={locale} className="mt-1" />
            ) : null}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {en
              ? 'Findings are recomputed on every read — a record you actually correct leaves the queue on its own. Use this for the ones that are not a problem: two genuine neighbours, two cousins on one household phone.'
              : 'تُحتسب الملاحظات عند كل فتح للشاشة — فالسجل الذي يُصحَّح فعلاً يخرج من القائمة وحده. استعمل هذا لما ليس مشكلة: جاران حقيقيان، أو ابنا عم على هاتف منزل واحد.'}
          </p>

          <div className="space-y-1.5">
            <label htmlFor="resolve-reason" className="text-sm font-medium">
              {en ? 'Why is this settled?' : 'لماذا اعتُبرت محلولة؟'}
            </label>
            <Textarea
              id="resolve-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
              autoFocus
              placeholder={
                en
                  ? 'e.g. two separate houses, different families'
                  : 'مثال: بيتان منفصلان وعائلتان مختلفتان'
              }
            />
            <p className="text-xs text-muted-foreground">
              {en ? 'At least four characters.' : 'أربعة أحرف على الأقل.'}
            </p>
          </div>

          {failure ? (
            <Alert variant="destructive" live="alert">
              {failure}
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={busy}
            onClick={() => close(false)}
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            className="w-full gap-1.5 sm:w-auto"
            disabled={busy || reason.trim().length < 4}
            onClick={run}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Mark resolved' : 'تم الحل'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
