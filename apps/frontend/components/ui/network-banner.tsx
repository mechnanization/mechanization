'use client';

import * as React from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useOnlineStatus } from '@/lib/offline-sync';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';

/**
 * «لا يوجد اتصال» — said once, where the whole app can see it.
 *
 * ## Why it is worth a strip of every screen
 *
 * The app already survives losing the connection: `shell-nav` swaps the client
 * router for plain anchors so a navigation is served from the Service Worker
 * cache, and a registration saved offline goes into the queue instead of the
 * wire. What none of that did was *say so*. An officer in a stairwell with two
 * bars saw a form that saved, a list that looked current and a search that
 * returned nothing, and had no way to tell a quiet town from a dropped signal
 * — which is the difference between "nobody lives here" and "ask again later".
 *
 * So the state gets one line, in the app's own warning tone, and it says what
 * still works rather than only what does not. An officer told "no connection"
 * stops working; an officer told "your entries are being kept" keeps going.
 *
 * ## Why it is not a toast
 *
 * A toast is an event and this is a condition: it lasts as long as the signal
 * is gone, and a notice that expires after four seconds is one the officer
 * will have forgotten by the time it matters. It sits in the layout, above the
 * page, and leaves when the connection comes back.
 */
export function NetworkBanner({
  locale = 'ar',
  className,
}: {
  locale?: string;
  className?: string;
}): React.JSX.Element | null {
  const online = useOnlineStatus();
  const en = locale === 'en';
  /*
    The first paint is the server's, where there is no `navigator`, so the hook
    starts optimistic and corrects itself on mount. Rendering nothing until it
    has is what stops the banner flashing onto every page load.
  */
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  if (!ready || online) return null;

  return (
    <div
      // Polite, not `alert`: losing the signal is a condition the officer will
      // meet on their own terms, not something to cut across what they are
      // reading mid-sentence.
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-warning/40 bg-warning/10 px-4 py-2 text-center text-xs text-warning sm:text-sm',
        className,
      )}
    >
      <Icon as={CloudOff} size="xs" />
      <span className="font-semibold">{en ? 'No connection' : 'لا يوجد اتصال بالإنترنت'}</span>
      <span className="text-warning/90">
        {en
          ? 'You can keep working — what you record is kept and sent when the signal returns.'
          : 'يمكنك متابعة العمل — ما تسجّله محفوظ ويُرسل عند عودة الاتصال.'}
      </span>
      {/*
        A reload rather than a retry: there is nothing here to retry, and a
        browser that has regained the signal serves the page it could not
        before. Harmless while still offline — the Service Worker answers.
      */}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline"
      >
        <Icon as={RefreshCw} size="xs" />
        {en ? 'Retry' : 'إعادة المحاولة'}
      </button>
    </div>
  );
}
