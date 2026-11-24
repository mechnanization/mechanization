import { ArrowLeft, ArrowRight, CloudOff, FileQuestion, Loader2, Save, ShieldAlert, Zap } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/*
  The citizen form's two action bars (GOD-22, phase 2a): the phone's four equal
  quarters pinned to the bottom of the screen, and the desktop's sticky row.
  Moved out of `citizen-form.tsx` as they were. Both are always in the page, one
  hidden by CSS, so they take the same props.
*/
export interface ActionBarProps {
  locale: string;
  mode: 'create' | 'edit';
  /** The browser has no connection, so saving queues the record on the device. */
  offline: boolean;
  submitting: boolean;
  /** Server-side failure; the desktop bar shows it above its buttons. */
  error: string | null;
  /** The open step's position, 0 for the first. */
  wizardIndex: number;
  /** Whether the unverified list is open, which has nowhere further to go. */
  reviewing: boolean;
  /** How many fields are flagged «غير مؤكَّد». */
  flagCount: number;
  /** A new file for somebody the register is certain about: saving is closed, with the reason beside it. */
  refusedAsDuplicate: boolean;
  refusedReason: string;
  onBack: () => void;
  onNext: () => void;
  onCancel: () => void;
  onOpenUnverified: () => void;
  onQuickSave: () => void;
  onSave: () => void;
}

export function MobileActionBar({
  locale,
  mode,
  offline,
  submitting,
  wizardIndex,
  reviewing,
  flagCount,
  refusedAsDuplicate,
  refusedReason,
  onBack,
  onNext,
  onCancel,
  onOpenUnverified,
  onQuickSave,
  onSave,
}: Omit<ActionBarProps, 'error'>) {
  /* ── Mobile Sticky Bottom Action Bar ── */
  /* Padded past the home indicator: without it the save row is the strip
      of screen iOS reserves for its own gesture, and every tap there is a
      swipe up instead. */
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 block sm:hidden border-t border-border/80 bg-background/95 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/90">
      {/*
        Four equal quarters, whatever the labels say. Sized to their own words
        they were four different buttons and «غير مؤكَّد» was squeezed to fit
        what was left; equal, the bar reads as one control with four parts.
      */}
      {refusedAsDuplicate ? (
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          {refusedReason}
        </p>
      ) : null}
      <div className="grid grid-flow-col auto-cols-fr gap-2">
        {wizardIndex > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onBack}
            className="h-10 w-full min-w-0 gap-1 px-1.5 text-xs font-semibold"
          >
            <ArrowRight className="size-4 shrink-0 rtl:rotate-180" />
            <span className="truncate">{locale === 'en' ? 'Back' : 'السابق'}</span>
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-10 w-full min-w-0 px-1.5 text-xs text-muted-foreground"
          >
            <span className="truncate">{locale === 'en' ? 'Cancel' : 'إلغاء'}</span>
          </Button>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenUnverified}
          className={cn(
            'h-10 w-full min-w-0 gap-1 px-1.5 text-xs font-medium',
            flagCount > 0 && 'border-warning/50 bg-warning/10 text-warning',
          )}
        >
          <FileQuestion className="size-3.5 shrink-0" />
          <span className="truncate">{locale === 'en' ? 'Unverified' : 'غير مؤكَّد'}</span>
          {flagCount > 0 ? (
            <span className="rounded-full bg-warning/20 px-1.5 py-0.2 text-xs font-bold text-warning">
              {flagCount}
            </span>
          ) : null}
        </Button>

        {/*
          Quick save sits next to «غير مؤكَّد» because they are the same
          decision at two scales: one field the officer could not establish,
          or a visit that produced almost nothing.

          Offered on a correction as well, so the two forms carry the same
          controls in the same places — a bar that loses a button between the
          screen you register on and the screen you fix a record on is the
          difference this section exists to remove. It is worth knowing what
          it now allows that it did not: a blanket reason on an *edit* excuses
          gaps in a record that has already been reviewed once, which is a
          broader claim than the same button makes on a first filing. The
          dialog still names the count and still writes the reason onto every
          gap it covers, so what was claimed and by whom stays on the file.
        */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onQuickSave}
          disabled={submitting || refusedAsDuplicate}
          title={refusedAsDuplicate ? refusedReason : undefined}
          className="h-10 w-full min-w-0 gap-1 px-1.5 text-xs font-medium"
        >
          <Zap className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{locale === 'en' ? 'Quick save' : 'حفظ سريع'}</span>
        </Button>

        {!reviewing ? (
          <Button
            type="button"
            size="sm"
            onClick={onNext}
            className="h-10 w-full min-w-0 gap-1 bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-sm"
          >
            <span className="truncate">{locale === 'en' ? 'Next' : 'التالي'}</span>
            <ArrowLeft className="size-4 shrink-0 rtl:rotate-180" />
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={submitting || refusedAsDuplicate}
            title={refusedAsDuplicate ? refusedReason : undefined}
            className="h-10 w-full min-w-0 gap-1 bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-sm"
          >
            {submitting ? (
              <Loader2 className="size-4 shrink-0 animate-spin" />
            ) : offline ? (
              <CloudOff className="size-4 shrink-0" />
            ) : (
              <Save className="size-4 shrink-0" />
            )}
            {/* «حفظ» on a correction: «حفظ وإنشاء» on a record that already
                exists promised a second file. */}
            <span className="truncate">
              {offline || mode === 'edit'
                ? locale === 'en'
                  ? 'Save'
                  : 'حفظ'
                : locale === 'en'
                  ? 'Save & Create'
                  : 'حفظ وإنشاء'}
            </span>
          </Button>
        )}
      </div>
    </div>
  );
}

export function DesktopActionBar({
  locale,
  mode,
  offline,
  submitting,
  error,
  wizardIndex,
  reviewing,
  refusedAsDuplicate,
  refusedReason,
  onBack,
  onNext,
  onCancel,
  onQuickSave,
  onSave,
}: Omit<ActionBarProps, 'flagCount' | 'onOpenUnverified'>) {
  /* ── Desktop Fixed Bottom Actions Bar ── */
  return (
    <div className="sticky bottom-0 z-30 hidden sm:block -mx-4 -mb-6 mt-8 border-t border-border/80 bg-background/95 px-4 py-3 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      {error ? (
        <Alert variant="destructive" live="alert" className="mb-2.5">
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
          The wizard's own controls, at the start of the row: «السابق» and
          «التالي» across all four steps. Equal widths, like the three on the
          other side.
        */}
        <div className="inline-grid grid-flow-col auto-cols-fr gap-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onBack}
            disabled={wizardIndex === 0}
            className="h-8 w-full gap-1.5 rounded-lg px-4 text-xs font-medium"
          >
            <ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden />
            {locale === 'en' ? 'Back' : 'السابق'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={reviewing}
            className="h-8 w-full gap-1.5 rounded-lg px-4 text-xs font-medium"
          >
            {locale === 'en' ? 'Next' : 'التالي'}
            <ArrowLeft className="size-3.5 rtl:rotate-180" aria-hidden />
          </Button>
        </div>

        {refusedAsDuplicate ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
            {refusedReason}
          </p>
        ) : (
        <div className="hidden lg:flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'inline-block size-2 rounded-full',
              offline ? 'bg-warning' : 'bg-primary/60',
            )}
          />
          <span>
            {offline
              ? locale === 'en'
                ? 'Offline — this record will be stored on this device and synced automatically'
                : 'بدون اتصال — سيُحفظ السجل على هذا الجهاز ويُرسل تلقائياً عند عودة الشبكة'
              : mode === 'edit'
                ? (locale === 'en' ? 'Editing citizen record' : 'تعديل بيانات المواطن')
                : (locale === 'en' ? 'New citizen registration' : 'تسجيل مواطن جديد')}
          </span>
        </div>
        )}

        {/*
          One width for all three — the widest label's — rather than three
          buttons sized to their own words. `auto-cols-fr` in a grid that
          sizes to its content makes every column as wide as the widest.
        */}
        <div className="inline-grid grid-flow-col auto-cols-fr gap-2.5">
          {/* Both modes, for the reason the mobile bar above gives. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onQuickSave}
            disabled={submitting || refusedAsDuplicate}
            title={refusedAsDuplicate ? refusedReason : undefined}
            className="h-8 w-full gap-1.5 rounded-lg px-4 text-xs font-medium"
          >
            <Zap className="size-3.5" aria-hidden />
            {locale === 'en' ? 'Quick save' : 'حفظ سريع'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
            className="h-8 w-full px-4 text-xs font-medium rounded-lg hover:bg-muted"
          >
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={submitting || refusedAsDuplicate}
            title={refusedAsDuplicate ? refusedReason : undefined}
            className="h-8 w-full px-4 text-xs font-medium rounded-lg shadow-2xs gap-1.5"
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : offline ? (
              <CloudOff className="size-3.5" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            {offline
              ? (locale === 'en' ? 'Save on This Device' : 'حفظ على الجهاز')
              : mode === 'edit'
                ? (locale === 'en' ? 'Save Changes' : 'حفظ التعديلات')
                : (locale === 'en' ? 'Save & Create' : 'حفظ وإنشاء')}
          </Button>
        </div>
      </div>
    </div>
  );
}
