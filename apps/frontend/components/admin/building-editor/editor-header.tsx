'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Loader2,
  Save,
} from 'lucide-react';
import {
  type BuildingDetail,
} from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';

/**
 * The wizard's title, its code line and the desktop «إلغاء» / «السابق» / «التالي» / save buttons.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function EditorHeader({
  headingRef,
  editing,
  en,
  displayCode,
  cancelHref,
  cancelDraft,
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
  headingRef: React.MutableRefObject<HTMLHeadingElement | null>;
  editing: boolean;
  en: boolean;
  displayCode: string | null;
  cancelHref: string;
  cancelDraft: () => void;
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/80 pb-5">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="flex size-11 sm:size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20 shadow-xs">
            <Building2 className="size-6" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-xl sm:text-2xl font-bold tracking-tight text-foreground outline-none"
              >
                {editing
                  ? en
                    ? 'Edit Building'
                    : 'تعديل المبنى'
                  : en
                    ? 'New Building'
                    : 'إضافة مبنى جديد'}
              </h1>
              {displayCode ? (
                <Badge variant="outline" className="font-mono text-xs px-2 py-0.5 border-primary/40 bg-primary/5 text-primary">
                  {displayCode}
                </Badge>
              ) : null}
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground">
              {editing
                ? en
                  ? 'Correct the structure and its matrix — floors and units can be added here at any time.'
                  : 'صحّح بيانات المنشأة ومصفوفتها — يمكن إضافة الطوابق والوحدات من هنا في أي وقت.'
                : en
                  ? 'Record the structure first — the units inside it are surveyed afterwards.'
                  : ''}
            </p>
          </div>
        </div>

        {/* Desktop Action Buttons */}
        <div className="hidden sm:flex items-center gap-2.5 shrink-0">
          <Link href={cancelHref} onClick={cancelDraft} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {en ? 'Cancel' : 'إلغاء'}
          </Link>
          {step > 0 ? (
            <Button variant="outline" size="sm" onClick={goBack} className="gap-1.5">
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
              className="gap-1.5 min-w-32 shadow-xs"
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
