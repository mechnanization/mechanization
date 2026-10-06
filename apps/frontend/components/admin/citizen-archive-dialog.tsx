'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Loader2 } from 'lucide-react';
import { ApiRequestError, logApiError, setCitizenActive } from '@/lib/api-client';
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
import { Textarea } from '@/components/ui/textarea';

/**
 * «أرشفة الملف» — the only way a citizen file leaves the register.
 *
 * A citizen record is never deleted (decision, 2026-10-05): a public register
 * keeps who was registered. A file opened by mistake, a duplicate, or someone
 * who left is archived — skipped by the biller and by sign-in, every row it
 * owns kept, back with one click if it was wrong. Two written answers are
 * required and go on the audit row: why, and who asked for it.
 */
export function CitizenArchiveDialog({
  tenant,
  token,
  citizen,
  onOpenChange,
  onArchived,
}: {
  tenant: string;
  token: string | null;
  /** The file being archived; null keeps the dialog closed. */
  citizen: { id: string; fullName: string } | null;
  onOpenChange: (open: boolean) => void;
  onArchived: (citizen: { id: string; fullName: string }) => void;
}) {
  const t = useTranslations('citizenArchive');
  const ids = { reason: useId(), requestedBy: useId() };
  const [reason, setReason] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!citizen) return;
    setReason('');
    setRequestedBy('');
    setFailure(null);
  }, [citizen]);

  const ready = reason.trim().length >= 3 && requestedBy.trim().length >= 2 && Boolean(token);

  const archive = async () => {
    if (!citizen || !token || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await setCitizenActive(tenant, token, citizen.id, false, {
        reason: reason.trim(),
        requestedBy: requestedBy.trim(),
      });
      onArchived(citizen);
    } catch (caught) {
      logApiError(caught);
      setFailure(caught instanceof ApiRequestError ? caught.message : t('failed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={citizen !== null} onOpenChange={(open) => (busy ? undefined : onOpenChange(open))}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning"
            >
              <Archive className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('description', { name: citizen?.fullName ?? '' })}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <Field label={t('reason')} htmlFor={ids.reason} required>
            <Textarea
              id={ids.reason}
              rows={2}
              maxLength={500}
              value={reason}
              placeholder={t('reasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Field label={t('requestedBy')} htmlFor={ids.requestedBy} required>
            <Input
              id={ids.requestedBy}
              maxLength={200}
              value={requestedBy}
              placeholder={t('requestedByPlaceholder')}
              onChange={(event) => setRequestedBy(event.target.value)}
              className="h-10"
            />
          </Field>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-11 w-full sm:h-10 sm:w-auto">
            {t('cancel')}
          </Button>
          <Button onClick={() => void archive()} disabled={!ready || busy} className="h-11 w-full sm:h-10 sm:w-auto">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Archive className="size-4" aria-hidden />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
