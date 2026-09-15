'use client';

import * as React from 'react';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Transient feedback for an action that has already happened.
 *
 * Until now nothing in this portal confirmed a write. A clerk pressed «حفظ»,
 * the dialog closed, and the only evidence the record had saved was the row
 * changing behind it — which it does whether the save succeeded or a stale
 * cache re-rendered. Failures were worse: `logApiError` printed to the console
 * and the screen said nothing at all.
 *
 * Written here rather than pulled from a toast library, for the reason
 * `ui/sheet.tsx` gives for its own existence: the behaviour is a timer, a
 * stack and an `aria-live` region, and owning it keeps the RTL placement and
 * the reduced-motion path under this codebase's control instead of a
 * vendor's defaults.
 */

type ToastTone = 'success' | 'error' | 'info' | 'warning';

interface ToastRecord {
  id: number;
  tone: ToastTone;
  title: string;
  /** Optional second line — the server's message, a count, a next step. */
  description?: string;
  /** One inline action, e.g. «تراجع» or «إعادة المحاولة». */
  action?: { label: string; onClick: () => void };
  duration: number;
}

/**
 * Everything except the title, which every raiser passes positionally —
 * `toast.success('تم الحفظ', { description })` reads as a sentence, and an
 * options bag whose one required key is the message does not.
 */
type ToastInput = Partial<Omit<ToastRecord, 'id' | 'tone'>>;

interface ToastApi {
  success: (title: string, options?: ToastInput) => void;
  error: (title: string, options?: ToastInput) => void;
  info: (title: string, options?: ToastInput) => void;
  warning: (title: string, options?: ToastInput) => void;
  dismiss: (id?: number) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

/**
 * At most four at once.
 *
 * A bulk action that fails per-row can raise one of these per row; past four
 * the stack covers the table it is describing, and the reader loses the thing
 * the message is about. The oldest is dropped rather than the newest, so the
 * most recent outcome is always the visible one.
 */
const MAX_VISIBLE = 4;

/** Errors stay until dismissed-ish; a success has nothing left to read. */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  // Long, not infinite: a failure the reader has walked away from should not
  // still be on screen when they return to a different task, but it must
  // outlast the time it takes to read a sentence of Arabic and decide.
  error: 10000,
};

const TONE_STYLES: Record<
  ToastTone,
  { icon: React.ComponentType<{ className?: string }>; accent: string; iconColor: string }
> = {
  success: { icon: CheckCircle2, accent: 'border-s-success', iconColor: 'text-success' },
  error: { icon: XCircle, accent: 'border-s-destructive', iconColor: 'text-destructive' },
  warning: { icon: TriangleAlert, accent: 'border-s-warning', iconColor: 'text-warning' },
  info: { icon: Info, accent: 'border-s-primary', iconColor: 'text-primary' },
};

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  // Which toast the pointer is resting on. Its timer is suspended: a message
  // the reader is actively looking at should not vanish mid-sentence.
  const [pausedId, setPausedId] = React.useState<number | null>(null);

  const dismiss = React.useCallback((id?: number) => {
    setToasts((current) => (id === undefined ? [] : current.filter((t) => t.id !== id)));
  }, []);

  const push = React.useCallback((tone: ToastTone, title: string, options?: ToastInput) => {
    const record: ToastRecord = {
      id: nextId++,
      tone,
      title,
      description: options?.description,
      action: options?.action,
      duration: options?.duration ?? DEFAULT_DURATION[tone],
    };
    setToasts((current) => [...current, record].slice(-MAX_VISIBLE));
  }, []);

  const api = React.useMemo<ToastApi>(
    () => ({
      success: (title, options) => push('success', title, options),
      error: (title, options) => push('error', title, options),
      info: (title, options) => push('info', title, options),
      warning: (title, options) => push('warning', title, options),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport
        toasts={toasts}
        pausedId={pausedId}
        onPause={setPausedId}
        onDismiss={dismiss}
      />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  pausedId,
  onPause,
  onDismiss,
}: {
  toasts: ToastRecord[];
  pausedId: number | null;
  onPause: (id: number | null) => void;
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  return (
    /*
     * Full-width along the bottom on a phone, a corner stack from `sm` up.
     *
     * A 384px card pinned to a corner of a 360px screen is either clipped or
     * overlapping whatever action raised it; at that width the message *is*
     * the bottom of the screen. `pointer-events-none` on the container with
     * the cards re-enabling it keeps the page behind clickable in the gaps —
     * otherwise an invisible full-width strip swallows taps on the last table
     * row.
     */
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-stretch gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:bottom-4 sm:end-4 sm:w-[380px] sm:max-w-[calc(100vw-2rem)] sm:p-0 sm:pb-0"
      // Polite, not assertive: these report completed work, and an assertive
      // region interrupts a screen reader mid-word on every saved row.
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          paused={pausedId === toast.id}
          onPause={onPause}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  paused,
  onPause,
  onDismiss,
}: {
  toast: ToastRecord;
  paused: boolean;
  onPause: (id: number | null) => void;
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  const { icon: Icon, accent, iconColor } = TONE_STYLES[toast.tone];

  React.useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
    // `paused` in the deps restarts the countdown when the pointer leaves,
    // which is the forgiving reading: the reader gets the full duration again
    // rather than the remainder of an interrupted one.
  }, [paused, toast.id, toast.duration, onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => onPause(toast.id)}
      onMouseLeave={() => onPause(null)}
      // Focus pauses it too — a keyboard user tabbing to the action button
      // would otherwise watch it disappear from under the cursor.
      onFocusCapture={() => onPause(toast.id)}
      onBlurCapture={() => onPause(null)}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border border-s-4 bg-card p-3.5 shadow-lg',
        // Slides up from the edge it is pinned to. `animate-in` is the
        // tailwindcss-animate plugin the design system already depends on, and
        // the global `prefers-reduced-motion` rule in globals.css collapses its
        // duration to nothing for readers who asked for that.
        'animate-in slide-in-from-bottom-4 fade-in duration-200',
        accent,
      )}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', iconColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug text-card-foreground">{toast.title}</p>
        {toast.description ? (
          // `break-words`: a server error can carry an unbroken reference
          // number longer than the card, which otherwise pushes the dismiss
          // button off the edge.
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {toast.description}
          </p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="mt-2 text-xs font-semibold text-primary underline-offset-4 hover:underline"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="إغلاق"
        className="-me-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * The one way to raise a message.
 *
 * Throws rather than falling back to a no-op when the provider is missing: a
 * silent toast is indistinguishable from the bug this component exists to fix,
 * and it would only be noticed on the failure path, in production.
 */
export function useToast(): ToastApi {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}
