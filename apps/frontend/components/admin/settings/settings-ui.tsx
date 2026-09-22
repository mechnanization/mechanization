'use client';

import { createContext, useContext } from 'react';
import { HardDrive, Info, Loader2, Save, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import type { SettingsCopy } from '@/lib/settings-i18n';
import { cn } from '@/lib/utils';

/**
 * The settings screen's building blocks, in the SolarManagementSystem house
 * style: a horizontal tab strip over one card per topic, each card ending in
 * its own right-aligned save row above a rule.
 *
 * That shape is carried over deliberately rather than reinvented. These two
 * products are administered by the same people, and a settings screen is where
 * an operator's muscle memory matters most — the tab strip, the card header
 * with its tinted icon, and "save lives at the bottom-right of the thing you
 * just edited" are the three habits worth keeping identical between them.
 *
 * The tokens are this app's own (`--primary`, `--muted`, the warm neutrals), so
 * a municipality's accent still repaints it; only the layout is shared.
 */

/**
 * Set by `AlignedFieldGrid`. Off by default, because a `Field` inside a dialog
 * or a one-off block sits in a grid that defines no row tracks to adopt.
 */
const AlignedRows = createContext(false);

/**
 * A grid whose fields line up with one another: every label in a row starts on
 * the same line, every control sits on the same line, and a hint hangs below
 * without dragging its own control out of step.
 *
 * It works by giving the grid three row tracks per row of fields — label,
 * control, hint — and having each field adopt those tracks with `subgrid`
 * instead of sizing its own. Because the tracks are shared, one field's
 * two-line label or long hint grows the track for the whole row rather than
 * shifting that field alone.
 *
 * This is the fix for the misalignment that ran through every row of this
 * screen: without it a field carrying a hint aligns its *hint* with its
 * neighbour's *input*, floating that input upward. Taken from Solar's
 * `AlignedFieldGrid`, which solved the same problem more completely than the
 * hint-below-input workaround it replaces here — labels stay above their
 * controls, which is where a form reader looks for them.
 *
 * One field per row, at every width, by decision: every input across the app
 * takes the full width of its form, so a settings field reads the same as the
 * one in the dialog beside it. The shared tracks still hold each label over
 * its control.
 */
export function AlignedFieldGrid({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AlignedRows.Provider value>
      <div className={cn('grid gap-y-4', className)}>
        {children}
      </div>
    </AlignedRows.Provider>
  );
}

/**
 * A labelled control.
 *
 * Inside an `AlignedFieldGrid` it spans the three shared row tracks. Outside
 * one it falls back to a bottom-anchored column: grid cells stretch to the
 * tallest in their row, so a label that wraps to two lines would otherwise push
 * its own input lower than the inputs beside it.
 *
 * No «اختياري» marker, unlike the shared `Field` this replaces on this screen.
 * On a form a citizen files, knowing which questions may be skipped matters; on
 * a settings page nearly every field is optional, so the marker lands on almost
 * every label and stops meaning anything. Required is marked instead, because
 * there it is the exception.
 */
export function SettingsField({
  label,
  htmlFor,
  error,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const aligned = useContext(AlignedRows);

  const caption = (
    <Label htmlFor={htmlFor} className="flex items-baseline gap-1.5 leading-snug">
      <span className="min-w-0">{label}</span>
      {required ? (
        <span className="text-sm font-semibold text-destructive" aria-label="required">
          *
        </span>
      ) : null}
    </Label>
  );

  const footnote = error ? (
    <p role="alert" className="text-xs leading-relaxed text-destructive">
      {error}
    </p>
  ) : null;

  if (aligned) {
    return (
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
        {caption}
        {children}
        {footnote}
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-col justify-end gap-1.5', className)}>
      {caption}
      {children}
      {footnote}
    </div>
  );
}

/**
 * The horizontal tab strip.
 *
 * Plain buttons over `@radix-ui/react-tabs`: this screen already owns the
 * active-section state, and the panel is rendered by the page rather than by a
 * `TabsContent` sibling, so the primitive would add a dependency to re-express
 * state that already exists. The classes are Solar's, so it looks the same.
 */
export function SettingsTabs<T extends string>({
  items,
  active,
  onSelect,
  label,
}: {
  items: ReadonlyArray<{ id: T; label: string; icon: React.ComponentType<{ className?: string }> }>;
  active: T;
  onSelect: (id: T) => void;
  label: string;
}) {
  return (
    <nav aria-label={label} className="w-full overflow-hidden">
      <div className="flex h-auto w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
                isActive
                  ? 'bg-background text-foreground shadow'
                  : 'hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {item.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * One topic's card: tinted icon, title, description, body.
 *
 * `<h3>` for the title because the page owns the `<h1>` and the tab strip names
 * the section — a settings screen read by heading level should list topics, not
 * a flat run of equal headings.
 */
export function SettingsCard({
  title,
  hint,
  icon: Icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** `p-0` for a card whose body is a full-bleed table. */
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row flex-wrap items-start gap-x-3 gap-y-3 space-y-0 p-4 sm:p-5">
        <div className="min-w-0 flex-1 basis-64 space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base font-semibold leading-none tracking-tight">
            {Icon ? <Icon className="size-4 shrink-0 text-primary" aria-hidden /> : null}
            {title}
          </CardTitle>
          {hint ? <CardDescription className="leading-relaxed">{hint}</CardDescription> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>
        ) : null}
      </CardHeader>
      <CardContent className={cn('p-4 pt-0 sm:p-5 sm:pt-0', bodyClassName)}>{children}</CardContent>
    </Card>
  );
}

/**
 * A card's save row: a rule, then the button at the reading-end.
 *
 * Solar's shape, and the reason to prefer it over the sticky bar this replaces
 * is that it puts the commit next to the thing being committed. A floating bar
 * saves "the section", which on a screen where one tab writes twelve fields and
 * another writes five is a promise the reader has to take on trust.
 */
export function SectionSaveRow({
  copy,
  saving,
  dirty,
  onSave,
  onDiscard,
  children,
}: {
  copy: SettingsCopy;
  saving: boolean;
  /** Undefined for a card that always offers its action, like a manual backup. */
  dirty?: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  /** Extra controls placed at the reading-start of the row. */
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
      {children ? <div className="me-auto flex items-center gap-2">{children}</div> : null}
      {dirty ? (
        <p className="me-auto text-xs text-muted-foreground">{copy.common.unsavedChanges}</p>
      ) : null}
      {onDiscard && dirty ? (
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          {copy.common.discard}
        </Button>
      ) : null}
      <Button onClick={onSave} disabled={saving || dirty === false}>
        {saving ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {copy.common.saving}
          </>
        ) : (
          <>
            <Save className="size-4" aria-hidden />
            {copy.common.save}
          </>
        )}
      </Button>
    </div>
  );
}

/** A small labelled fact — Solar's status tile. */
export function StatusTile({
  label,
  icon,
  children,
  className,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-md border bg-muted/30 p-3 text-sm', className)}>
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

/** A standing caveat about a whole section, stated before its controls. */
export function Notice({
  tone = 'warning',
  title,
  children,
  className,
}: {
  tone?: 'warning' | 'info';
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === 'warning' ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 text-sm leading-relaxed',
        tone === 'warning' ? 'border-warning/30 bg-warning/5' : 'border-primary/25 bg-primary/5',
        className,
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'warning' ? 'text-warning' : 'text-primary',
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <p className={cn('font-semibold', tone === 'warning' ? 'text-warning' : 'text-primary')}>
          {title}
        </p>
        {children ? <div className="mt-0.5 text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * Marks the one thing on this screen still held in the browser: the backup
 * history, which records what *this* machine downloaded. The archive is on this
 * disk and nowhere else, so a shared server-side log would list files another
 * administrator cannot open.
 */
export function LocalOnlyNotice({ copy }: { copy: SettingsCopy }) {
  return (
    <Notice tone="info" title={copy.common.notConnected}>
      <p className="flex items-start gap-2">
        <HardDrive className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {copy.common.notConnectedHint}
      </p>
    </Notice>
  );
}

/**
 * A table that scrolls rather than crushes.
 *
 * `overflow-x-auto` alone does nothing without a floor: the table shrinks to
 * whatever space it is given, so five columns on a 360px screen become five
 * 70px columns of wrapped single characters. The min-width turns squashing into
 * scrolling.
 */
export function ScrollableTable({
  minWidth = '44rem',
  children,
}: {
  minWidth?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth }}>{children}</div>
    </div>
  );
}
/**
 * A captioned run of fields inside a card.
 *
 * Carries the grouping the five separate cards used to provide, for a rule and
 * a caption instead of a card, header and shadow each. Without it, eleven
 * inputs in one grid read as one undifferentiated form.
 */
export function FieldGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h4 className="flex items-center gap-2 border-b pb-2 text-sm font-semibold text-muted-foreground">
        <Icon className="size-3.5 text-primary" aria-hidden />
        {title}
      </h4>
      {children}
    </section>
  );
}
