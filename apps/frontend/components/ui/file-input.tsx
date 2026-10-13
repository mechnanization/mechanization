'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * «اختر ملفاً» — picks one or more files, by the system dialog or by dropping
 * them on the zone (PRIM-30).
 *
 * The native `<input type="file">` stays in the page, visually hidden, and is
 * the control: it takes the focus, Enter and Space open the dialog, and a
 * screen reader announces it by the zone's label. The zone is its `<label>`, so
 * a click anywhere on it opens the same dialog, and dropping files on it hands
 * them over the same way. Nothing here uploads: the caller checks each file and
 * sends it (`onSelect`), and keeps the list it shows.
 *
 * Every string is a prop with an Arabic default (KIT-6); callers on `/en/` pass
 * the English. The input is cleared after each pick, so choosing the same file
 * twice is two picks.
 */
export function FileInput({
  id,
  accept,
  multiple = false,
  disabled = false,
  onSelect,
  label = 'اختر ملفاً أو اسحبه إلى هنا',
  hint,
  invalid = false,
  className,
}: {
  id: string;
  /** What the dialog offers, e.g. `image/jpeg,image/png,application/pdf`. The server checks the bytes regardless. */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onSelect: (files: File[]) => void;
  label?: string;
  /** One line under the label: what is accepted, and how large. */
  hint?: string;
  invalid?: boolean;
  className?: string;
}): React.JSX.Element {
  const [dragging, setDragging] = React.useState(false);
  const hintId = React.useId();

  const hand = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length === 0 || disabled) return;
    onSelect(multiple ? files : files.slice(0, 1));
  };

  return (
    <div className={cn('relative', className)}>
      <input
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        aria-invalid={invalid || undefined}
        className="peer sr-only"
        onChange={(event) => {
          hand(event.target.files);
          event.target.value = '';
        }}
      />
      <label
        htmlFor={id}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          hand(event.dataTransfer.files);
        }}
        className={cn(
          'flex min-h-touch cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background',
          invalid ? 'border-destructive/60' : dragging ? 'border-primary/60 bg-primary/5' : 'border-input bg-muted/20 hover:border-primary/50 hover:bg-muted/40',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <Upload className="size-5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint ? (
          <span id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}
