'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Save,
} from 'lucide-react';
import {
  type BuildingDetail,
} from '@/lib/api-client';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The wizard's footer buttons on a desktop.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function DesktopFooter({
  cancelHref,
  cancelDraft,
  en,
  step,
  goBack,
  lastStep,
  goNext,
  canGoNext,
  handleSave,
  saving,
  staleDraft,
  saveLabel,
}: {
  cancelHref: string;
  cancelDraft: () => void;
  en: boolean;
  step: 0 | 2 | 1;
  goBack: () => void;
  lastStep: 0 | 2 | 1;
  goNext: () => void;
  canGoNext: boolean;
  handleSave: (confirmed?: boolean) => Promise<void>;
  saving: boolean;
  staleDraft: BuildingDetail | null;
  saveLabel: "Save Changes" | "حفظ التعديلات" | "Save Building" | "حفظ المبنى" | "Create Building" | "إنشاء المبنى";
}): React.JSX.Element {
  return (
    <>
      <div className="hidden sm:flex items-center justify-between pt-2">
        <Link
          href={cancelHref}
          onClick={cancelDraft}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {en ? 'Cancel' : 'إلغاء'}
        </Link>
        <div className="flex items-center gap-3">
          {step > 0 ? (
            <Button variant="outline" size="sm" onClick={goBack} className="gap-1.5 min-w-24">
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              {en ? 'Back' : 'السابق'}
            </Button>
          ) : null}
          {step < lastStep ? (
            <Button
              size="sm"
              onClick={goNext}
              disabled={!canGoNext}
              className="gap-1.5 min-w-28 shadow-xs"
            >
              {en ? 'Next' : 'التالي'}
              <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
            </Button>
          ) : (
            <Button
              onClick={() => void handleSave()}
              disabled={saving || !canGoNext || staleDraft !== null}
              aria-describedby={staleDraft ? 'building-stale-draft' : undefined}
              size="sm"
              className="gap-1.5 min-w-36 shadow-xs"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Save className="size-4" aria-hidden />
              )}
              <span>{saveLabel}</span>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The sticky action bar on a phone.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function MobileBar({
  step,
  goBack,
  en,
  cancelHref,
  cancelDraft,
  lastStep,
  goNext,
  canGoNext,
  handleSave,
  saving,
  staleDraft,
  saveLabel,
}: {
  step: 0 | 2 | 1;
  goBack: () => void;
  en: boolean;
  cancelHref: string;
  cancelDraft: () => void;
  lastStep: 0 | 2 | 1;
  goNext: () => void;
  canGoNext: boolean;
  handleSave: (confirmed?: boolean) => Promise<void>;
  saving: boolean;
  staleDraft: BuildingDetail | null;
  saveLabel: "Save Changes" | "حفظ التعديلات" | "Save Building" | "حفظ المبنى" | "Create Building" | "إنشاء المبنى";
}): React.JSX.Element {
  return (
    <>
      {/* ── Sticky Mobile Action Bar ── */}
      <div className="sm:hidden fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur-md border-t p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] z-40 flex items-center gap-3 shadow-lg">
        {step > 0 ? (
          <Button variant="outline" onClick={goBack} className="h-11 px-4 text-xs gap-1.5">
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            {en ? 'Back' : 'السابق'}
          </Button>
        ) : (
          <Link
            href={cancelHref}
            onClick={cancelDraft}
            className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 h-11 text-xs')}
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Link>
        )}
        {step < lastStep ? (
          <Button onClick={goNext} disabled={!canGoNext} className="flex-1 h-11 text-xs gap-1.5 shadow-xs">
            {en ? 'Next' : 'التالي'}
            <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
          </Button>
        ) : (
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !canGoNext || staleDraft !== null}
            aria-describedby={staleDraft ? 'building-stale-draft' : undefined}
            className="flex-1 h-11 text-xs gap-1.5 shadow-xs"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Save className="size-4" aria-hidden />
            )}
            <span>{saveLabel}</span>
          </Button>
        )}
      </div>
    </>
  );
}
