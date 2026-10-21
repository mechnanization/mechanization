'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * A slide-over panel pinned to one edge of the screen, over the page, for
 * reading or editing one thing without leaving the list it came from.
 *
 * Built on Radix Dialog since 2026-10-12 (it was a hand-rolled overlay with no
 * focus trap and no focus restore, A11Y-6): it traps focus while open, closes on
 * Escape and on a press outside it, locks the scroll behind it, labels itself
 * by its title, and gives the focus back to what opened it when it closes.
 * Nested dialogs (a confirmation inside the panel) stack on it as Radix
 * dialogs do.
 *
 * On a phone it is the screen's whole width (`w-full max-w-md`).
 */
interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** The panel's name: its heading, and what the dialog is announced as. */
  title: React.ReactNode;
  description?: React.ReactNode;
  /**
   * Which physical edge the panel is pinned to.
   *
   * `inline-end` is the default and follows text direction — right in LTR,
   * left in RTL — which is what a form's contextual panel should do. `left`
   * and `right` are absolute and ignore direction, for a panel anchored to
   * something on the canvas behind it rather than to the reading order.
   */
  side?: 'inline-end' | 'left' | 'right';
  /** Rendered under the scrolling body, always on screen — e.g. the panel's actions. */
  footer?: React.ReactNode;
  /** The close control's accessible name; callers on `/en/` pass the English (KIT-6). */
  closeLabel?: string;
  className?: string;
  children: React.ReactNode;
}

export function Sheet({
  open,
  onClose,
  title,
  description,
  side = 'inline-end',
  footer,
  closeLabel = 'إغلاق',
  className,
  children,
}: SheetProps): React.JSX.Element {
  /**
   * Whether a press has begun inside the sheet since it opened.
   *
   * A tap's `click` arrives after its `pointerup`, and on touch the browser
   * hit-tests it again at that moment. An opener that acts on `pointerup` — the
   * unit matrix's drag-to-select does — has mounted the sheet by then, so on a
   * phone, where the panel covers the screen, the very tap that opened it
   * landed on whichever control sat under the finger. That is why a matrix
   * cell took several taps to open.
   *
   * A click that no press inside the sheet started is that tap finishing, and
   * is dropped. Keyboard and assistive-technology activation report `detail`
   * 0 and have no press to find, so they are never dropped. (Radix closes the
   * sheet on a press outside it, once that press's click lands, and listens only
   * from just after it opened, so the opening tap cannot close it.)
   */
  const pressedInside = React.useRef(false);
  /**
   * What had the focus when the sheet opened, to give it back on close. Radix
   * returns the focus to a `Dialog.Trigger`, and a sheet opened from state has
   * none: without this the focus fell to the page's body, and a keyboard user
   * started again from the top of the page.
   */
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    return () => {
      pressedInside.current = false;
    };
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPrimitive.Portal>
        {/*
          The scrim. Radix closes the sheet on a press that starts on it, and on
          Escape; it is not a control of its own, so it has no hover treatment.
        */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:duration-200 data-[state=closed]:duration-150" />
        <DialogPrimitive.Content
          ref={contentRef}
          tabIndex={-1}
          // A sheet without a description is labelled by its title alone.
          {...(description ? {} : { 'aria-describedby': undefined })}
          /*
            The focus goes to the panel itself, not its first control: a phone
            would raise its keyboard over the panel for a field nobody chose,
            and a reader hears the dialog's name before its first button.
          */
          onOpenAutoFocus={(event) => {
            // Radix asks before it moves the focus, so what has it now is what opened the sheet.
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            if (target?.isConnected) target.focus({ preventScroll: true });
          }}
          onPointerDownCapture={() => {
            pressedInside.current = true;
          }}
          onClickCapture={(event) => {
            if (event.detail > 0 && !pressedInside.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          className={cn(
            'fixed inset-y-0 z-50 flex h-full w-full max-w-md flex-col bg-card shadow-xl outline-none',
            /*
              In from its own edge and back out to it, 200ms in and 150ms out on
              an ease-out (MOT-2, MOT-3). `slide-in-from-right` is physical, so the
              inline end is spelled per direction.
            */
            'ease-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-150',
            side === 'left'
              ? 'left-0 border-e data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left'
              : side === 'right'
                ? 'right-0 border-s data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right'
                : 'end-0 border-s data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right rtl:data-[state=open]:slide-in-from-left rtl:data-[state=closed]:slide-out-to-left',
            className,
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b p-4 sm:p-6">
            <div className="min-w-0 space-y-1">
              <DialogPrimitive.Title className="text-xl font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description asChild>
                  <div className="text-sm text-muted-foreground">{description}</div>
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="shrink-0" aria-label={closeLabel}>
                <X className="size-5" aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {/* Only the body scrolls, so a long co-owner list never pushes the
              header or the footer action out of reach. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>

          {footer ? (
            <div className="shrink-0 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
