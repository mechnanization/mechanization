'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('qualityFindings');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  /* As of this instant: two presses in one tick see it, where `busy` is a render late (STA-3). */
  const sending = useRef(false);
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
    if (reason.trim().length < 4 || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(reason.trim());
      setReason('');
      onOpenChange(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('saveFailed'));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" closeLabel={t('dialog.cancel')}>
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('dialog.description')}
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
            {t('dialog.explanation')}
          </p>

          <div className="space-y-1.5">
            <label htmlFor="resolve-reason" className="text-sm font-medium">
              {t('dialog.reason')}
            </label>
            <Textarea
              id="resolve-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
              autoFocus
              placeholder={t('dialog.placeholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('dialog.minimum')}
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
            {t('dialog.cancel')}
          </Button>
          <Button
            className="w-full gap-1.5 sm:w-auto"
            disabled={busy || reason.trim().length < 4}
            onClick={run}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t('dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
