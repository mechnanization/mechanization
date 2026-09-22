'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The one confirmation prompt, for actions that cannot be undone.
 *
 * Deleting a citizen, a staff account, a قطاع or a رسم each had its own
 * `window.confirm` or its own bespoke dialog — which meant the browser's
 * unstyled, un-localised, LTR prompt in some places and a "Cancel / OK" pair
 * that gives no clue which button destroys something in others.
 *
 * `requireText` is the escalation for the small number of actions where the
 * blast radius is a whole record with history attached: the reader types the
 * subject's own name, which is the one confirmation that cannot be dismissed
 * by muscle memory.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  destructive = true,
  requireText,
  requireTextHint,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button and red icon. Off for a merely irreversible action. */
  destructive?: boolean;
  /** When set, Confirm stays disabled until this exact text is typed. */
  requireText?: string;
  requireTextHint?: string;
  /** Awaited — the dialog stays open and busy until it settles. */
  onConfirm: () => Promise<void> | void;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [failure, setFailure] = React.useState<string | null>(null);

  // Reset on close so re-opening never starts with the previous attempt's
  // typed text or error still showing.
  React.useEffect(() => {
    if (!open) {
      setTyped('');
      setFailure(null);
      setBusy(false);
    }
  }, [open]);

  const entered = typed.trim();
  const blocked = Boolean(requireText) && entered !== requireText;
  // Only a *wrong* entry is an error. An empty box is someone who has not
  // typed yet, and colouring it red reads as a rejection of nothing.
  const mismatch = Boolean(requireText) && entered.length > 0 && entered !== requireText;

  const run = async (): Promise<void> => {
    if (busy || blocked) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      /*
       * The failure is shown *here* rather than raised as a toast, and the
       * dialog stays open. A delete that the server refused — a قطاع still
       * holding parcels, a citizen with payments against them — leaves the
       * reader with a decision still to make, and closing the dialog to put
       * the reason in a corner of the screen throws away the context that
       * makes the reason legible.
       */
      setFailure(error instanceof Error ? error.message : 'تعذّر إتمام العملية.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={cancelLabel}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full',
                destructive ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary',
              )}
            >
              <TriangleAlert className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </div>
          </div>
        </DialogHeader>

        {requireText ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {requireTextHint ?? (
                <>
                  اكتب <span className="font-semibold text-foreground">{requireText}</span> للتأكيد
                </>
              )}
            </p>
            <Input
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !blocked) {
                  event.preventDefault();
                  void run();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={mismatch}
              aria-label={requireTextHint ?? `اكتب ${requireText} للتأكيد`}
              className={cn(mismatch && 'border-destructive focus-visible:ring-destructive')}
            />
          </div>
        ) : null}

        {failure ? (
          <Alert tone="error" size="sm">
            {failure}
          </Alert>
        ) : null}

        {/* Column-reversed on a phone so the confirming action is the one
            under the thumb, and the two buttons are full width rather than a
            pair of narrow targets crowded against the end edge. */}
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={run}
            disabled={busy || blocked}
            className="w-full sm:w-auto"
          >
            {busy ? 'جارٍ التنفيذ…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
