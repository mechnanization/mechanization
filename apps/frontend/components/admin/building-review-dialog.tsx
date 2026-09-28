'use client';

import { ClipboardCheck } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { BuildingDetail, BuildingMatrixSave, BuildingMatrixSaveResult } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * «مراجعة التعديلات» for a building — the save the server rehearsed and rolled
 * back (`saveBuildingMatrix` with `dryRun`), shown before it is confirmed.
 *
 * The building's own fields, before → after, compared with the building as the
 * editor loaded it; then the matrix as the server would leave it — the unit
 * codes removed, moved and added. A save the server would refuse never reaches
 * this dialog: the rehearsal's refusal is shown on the form instead, naming
 * the unit, with nothing written.
 */
export function BuildingReviewDialog({
  loaded,
  review,
  open,
  onCancel,
  onConfirm,
  saving,
  locale = 'ar',
}: {
  loaded: BuildingDetail | null;
  review: { save: BuildingMatrixSave; result: BuildingMatrixSaveResult } | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  saving: boolean;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  if (!review || !loaded) return null;
  const next = review.save.building;
  const { removed, updated, added } = review.result;

  const text = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? (en ? 'Yes' : 'نعم') : en ? 'No' : 'لا';
    if (Array.isArray(value)) return value.length ? value.join('، ') : '—';
    return String(value);
  };
  const lines: Array<{ label: string; before: string; after: string }> = [];
  const compare = (label: string, before: unknown, after: unknown, show: (value: unknown) => string = text) => {
    if (after === undefined) return;
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
    lines.push({ label, before: show(before), after: show(after) });
  };
  const structure = (value: unknown) =>
    (labels.structureType as Record<string, string>)[String(value)] ?? text(value);
  const lifecycle = (value: unknown) =>
    (labels.buildingLifecycle as Record<string, string>)[String(value)] ?? text(value);

  compare(en ? 'Name' : 'اسم المبنى', loaded.name, next.name);
  compare(en ? 'Posted number' : 'الرقم المكتوب على المبنى', loaded.postedNumber, next.postedNumber);
  compare(en ? 'Structure type' : 'نوع المنشأة', loaded.structureType, next.structureType, structure);
  compare(en ? 'Lifecycle' : 'الحالة الإنشائية', loaded.lifecycleStatus, next.lifecycleStatus, lifecycle);
  compare(en ? 'Partitioned' : 'مفروزة', loaded.isPartitioned === true, next.isPartitioned === true);
  compare(en ? 'Partition numbers' : 'أرقام الأقسام', loaded.partitionNumbers ?? [], next.partitionNumbers);
  compare(en ? 'Shared parcels' : 'العقارات المشتركة', loaded.sharedParcelNumbers ?? [], next.sharedParcelNumbers);
  compare(en ? 'Floors' : 'عدد الطوابق', loaded.floorsCount, next.floorsCount);
  compare(en ? 'Basements' : 'الطوابق السفلية', loaded.basementsCount ?? 0, next.basementsCount);
  compare(en ? 'Notes' : 'الملاحظات', loaded.notes, next.notes);
  const hadPin = loaded.latitude != null;
  const hasPin = next.latitude != null;
  if (hadPin !== hasPin || (hasPin && (loaded.latitude !== next.latitude || loaded.longitude !== next.longitude))) {
    lines.push({
      label: en ? 'Entrance pin' : 'دبوس المدخل',
      before: hadPin ? (en ? 'Pinned' : 'مثبَّت') : '—',
      after: !hasPin ? (en ? 'Removed' : 'يُزال') : hadPin ? (en ? 'Moved' : 'نُقل') : en ? 'Pinned' : 'يُثبَّت',
    });
  }

  const matrix = [
    removed.length ? { label: en ? 'Units removed' : 'وحدات تُحذف', codes: removed, tone: 'text-destructive' } : null,
    updated.length ? { label: en ? 'Units changed' : 'وحدات تُعدَّل', codes: updated, tone: 'text-foreground' } : null,
    added.length ? { label: en ? 'Units added' : 'وحدات تُضاف', codes: added, tone: 'text-success' } : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
  const nothing = lines.length === 0 && matrix.length === 0;

  return (
    <Dialog open={open} onOpenChange={(value) => (value || saving ? undefined : onCancel())}>
      <DialogContent className="max-w-lg" closeLabel={en ? 'Close' : 'إغلاق'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <ClipboardCheck className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>{en ? 'Review the changes' : 'مراجعة التعديلات'}</DialogTitle>
              <DialogDescription>
                {en
                  ? 'The server checked this save without writing it. Nothing is saved until you confirm.'
                  : 'تحقّق الخادم من هذا الحفظ دون تنفيذه. لا يُحفظ شيء قبل أن تؤكّد.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {nothing ? (
          <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
            {en ? 'Nothing on the building changes.' : 'لا يتغيّر شيء في المبنى.'}
          </p>
        ) : (
          <div className="space-y-3">
            {lines.length > 0 ? (
              <ul className="divide-y rounded-md border px-3 py-1">
                {lines.map((line) => (
                  <li key={line.label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm">
                    <span className="text-muted-foreground">{line.label}</span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-muted-foreground line-through decoration-1">{line.before}</span>
                      <span aria-hidden className="text-muted-foreground">←</span>
                      <span className="font-medium">{line.after}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {matrix.length > 0 ? (
              <ul className="space-y-1.5 rounded-md bg-muted/40 p-3 text-sm">
                {matrix.map((row) => (
                  <li key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted-foreground">
                      {row.label} ({row.codes.length})
                    </span>
                    <bdi dir="ltr" className={`font-mono text-xs ${row.tone}`}>
                      {row.codes.join(' · ')}
                    </bdi>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel} disabled={saving} className="h-11 w-full sm:h-10 sm:w-auto">
            {en ? 'Back to the editor' : 'العودة إلى المحرّر'}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={saving}
            className="h-11 w-full transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none sm:h-10 sm:w-auto"
          >
            <ClipboardCheck className="size-4" aria-hidden />
            {en ? 'Confirm and save' : 'تأكيد وحفظ'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
