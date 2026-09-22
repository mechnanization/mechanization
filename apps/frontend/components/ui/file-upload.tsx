'use client';

import * as React from 'react';
import { Loader2, UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * «اختر ملفاً أو اسحبه إلى هنا» — one drop zone, four screens.
 *
 * ## What it unifies
 *
 * «استيراد المواطنين», «النسخ الاحتياطي», «الخريطة العقارية» and «الصورة
 * الشخصية» each carried their own copy of the same sixty lines: a visually
 * hidden `<input type="file">`, a `role="button"` div that clicks it, keyboard
 * handling for Enter and Space, four drag handlers with their own `dragging`
 * state, and a busy state that had to remember to turn off the pointer.
 *
 * Copied code is not the worst of it. The keyboard and drag halves are the
 * parts people leave out when they copy in a hurry, so whether an officer could
 * upload a file without a mouse depended on which screen they were on.
 *
 * ## Why the input is hidden rather than styled
 *
 * A file input cannot be restyled across browsers, and the native button's
 * label is not translatable. So the real input stays in the accessibility tree
 * and out of the layout, and the zone is what is drawn — which is why the zone
 * carries the button role and the key handling rather than being a `<label>`:
 * a label around a drop target swallows the drag events in some browsers.
 */
export function FileDropZone({
  onFile,
  accept,
  busy = false,
  disabled = false,
  title,
  hint,
  constraints,
  className,
}: {
  /** Called with the chosen file. One at a time — no caller here takes a set. */
  onFile: (file: File) => void;
  /** Passed straight to the input, e.g. `.csv,text/csv`. */
  accept?: string;
  /** An upload is running: the zone stops taking files and says so. */
  busy?: boolean;
  disabled?: boolean;
  /** The line in bold — «اختر ملفاً», or «جارٍ الرفع…» while busy. */
  title: React.ReactNode;
  /** After the title, in muted ink — «أو اسحبه إلى هنا». Hidden while busy. */
  hint?: React.ReactNode;
  /** What the file has to be: formats, size, a row limit. */
  constraints?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const input = React.useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inert = busy || disabled;

  const open = () => {
    if (!inert) input.current?.click();
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        disabled={inert}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          /*
            Cleared after reading, so choosing the same file twice in a row
            fires `change` the second time as well — the ordinary way a failed
            upload is retried, and a silent no-op without this.
          */
          event.target.value = '';
          if (file) onFile(file);
        }}
      />

      <div
        role="button"
        tabIndex={inert ? -1 : 0}
        aria-disabled={inert || undefined}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        }}
        onDragOver={(event) => {
          if (inert) return;
          // Without this the browser navigates to the dropped file instead.
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (inert) return;
          const file = event.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={cn(
          'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-all sm:p-6',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          dragging
            ? 'border-primary/60 bg-muted/30'
            : 'border-muted-foreground/25 bg-muted/10 hover:border-primary/60 hover:bg-muted/30',
          inert && 'pointer-events-none opacity-60',
          className,
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-110">
          {busy ? (
            <Loader2 className="size-6 animate-spin" aria-hidden />
          ) : (
            <UploadCloud className="size-6" aria-hidden />
          )}
        </span>
        <p className="text-sm">
          <span className="font-semibold group-hover:text-primary">{title}</span>
          {!busy && hint ? <span className="text-muted-foreground"> {hint}</span> : null}
        </p>
        {constraints ? <p className="text-xs text-muted-foreground">{constraints}</p> : null}
      </div>
    </>
  );
}
