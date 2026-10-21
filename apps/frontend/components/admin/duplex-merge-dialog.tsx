'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Layers, Loader2 } from 'lucide-react';
import { unitLevelsLabel, type DuplexMergeBlocker } from '@mechanization/shared-schemas';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SkeletonText } from '@/components/ui/skeleton';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import {
  ApiRequestError,
  applyDuplexMerge,
  getDuplexMergePreview,
  logApiError,
  unitCorrectionRefusal,
  type DuplexMergePreview,
  type DuplexMergeResult,
} from '@/lib/api-client';
import { useStaffRole } from '@/components/admin/unit-correction-delete-dialog';

/*
  «دمج مع الوحدة العلوية كدوبلكس» (decision D28) — two flats recorded as two
  units that are one home on two levels (B-1-352-A). SUPER_ADMIN only, like
  «حذف تصحيحي»: it removes the upper flat the same way, after moving what the
  home keeps onto the lower one. Previewed, confirmed with the upper flat's code,
  one transaction on the server.
*/

/** The «لماذا لا» line for one refusal, in the reader's language. */
function useBlockerText() {
  const t = useTranslations('unitLevels.merge.blocker');
  return (blocker: DuplexMergeBlocker): string => {
    switch (blocker.kind) {
      case 'TOO_MANY_LEVELS':
        return t('TOO_MANY_LEVELS', { max: blocker.max });
      case 'OTHER_HOUSEHOLD':
      case 'CARD_WITHOUT_LOWER':
      case 'LINK_NAMES_OTHER_UNITS':
      case 'UNREADABLE_LANDLORD_LINK':
        return t(blocker.kind, { name: blocker.citizenName });
      case 'DAMAGE_ASSESSMENT':
        return t('DAMAGE_ASSESSMENT', { count: blocker.count });
      default:
        return t(blocker.kind);
    }
  };
}

function DuplexMergeDialog({
  open,
  onOpenChange,
  tenant,
  token,
  unitId,
  locale,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  unitId: string;
  locale: string;
  onMerged: (result: DuplexMergeResult) => void;
}) {
  const t = useTranslations('unitLevels.merge');
  const blockerText = useBlockerText();
  const toast = useToast();
  const [preview, setPreview] = React.useState<DuplexMergePreview | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [area, setArea] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [code, setCode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoadError(null);
      try {
        const next = await getDuplexMergePreview(tenant, token, unitId, signal);
        setPreview(next);
        setArea(next.areaAfter ? String(Number(next.areaAfter)) : '');
      } catch (caught) {
        if (signal?.aborted) return;
        logApiError(caught);
        setLoadError(caught instanceof ApiRequestError ? caught.message : t('loadFailed'));
      }
    },
    [tenant, token, unitId, t],
  );

  React.useEffect(() => {
    if (!open) return;
    setPreview(null);
    setReason('');
    setCode('');
    setError(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  // `AREA_UNKNOWN` is lifted by the area typed here; every other blocker stands.
  const blockers = (preview?.blockers ?? []).filter((blocker) => blocker.kind !== 'AREA_UNKNOWN');
  const areaValue = Number(area);
  const areaValid = area.trim() !== '' && Number.isFinite(areaValue) && areaValue > 0;
  const canSubmit =
    preview !== null &&
    blockers.length === 0 &&
    areaValid &&
    reason.trim().length >= 10 &&
    code.trim() === preview.upper.unitCode &&
    !submitting;
  const name = preview ? (unitLevelsLabel(preview.levelsAfter, locale) ?? '') : '';

  const submit = async () => {
    if (!preview || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const summed = preview.areaAfter !== null && Number(preview.areaAfter) === areaValue;
      const result = await applyDuplexMerge(tenant, token, unitId, {
        fingerprint: preview.fingerprint,
        reason: reason.trim(),
        confirmCode: code.trim(),
        // Sent only when it differs from the summed figure, or there was none.
        ...(summed ? {} : { totalArea: areaValue }),
      });
      toast.success(
        t('done', {
          lower: result.unitCode,
          name: unitLevelsLabel(result.levels, locale) ?? '',
          area: result.unitArea ? Number(result.unitArea).toLocaleString('en-US') : '—',
        }),
      );
      onOpenChange(false);
      onMerged(result);
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof ApiRequestError ? caught.message : t('failed'));
      // The data moved under the preview: show the new one rather than a dead end.
      if (unitCorrectionRefusal(caught) === 'PREVIEW_STALE') void load();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {preview ? t('title', { lower: preview.lower.unitCode, upper: preview.upper.unitCode }) : t('button')}
          </DialogTitle>
          {preview ? (
            <DialogDescription>
              {t('description', { lower: preview.lower.unitCode, upper: preview.upper.unitCode, name })}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {loadError ? (
          <Alert variant="destructive" live="alert">
            <span className="block">{loadError}</span>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </Alert>
        ) : !preview ? (
          <div className="space-y-2" aria-busy="true">
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
            <SkeletonText lines={4} />
          </div>
        ) : (
          <div className="space-y-4">
            {blockers.length > 0 ? (
              <Alert variant="destructive" title={t('blockedTitle')}>
                <ul className="list-disc space-y-1 ps-4">
                  {blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}-${index}`}>{blockerText(blocker)}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t('afterTitle')}</h3>
              <SummaryList>
                <SummaryRow label={t('levels')}>
                  <span className="inline-flex items-center gap-1">
                    <Layers className="size-3.5" aria-hidden />
                    {name}
                  </span>
                </SummaryRow>
                <SummaryRow label={t('visits', { lower: preview.lower.unitCode })}>
                  <span className="tabular-nums">{preview.visitsMoved}</span>
                </SummaryRow>
                <SummaryRow label={t('cases', { lower: preview.lower.unitCode })}>
                  <span className="tabular-nums">{preview.casesMoved}</span>
                </SummaryRow>
                <SummaryRow
                  label={t('occupancies', { upper: preview.upper.unitCode, lower: preview.lower.unitCode })}
                >
                  <span className="tabular-nums">{preview.occupanciesRemoved}</span>
                </SummaryRow>
                <SummaryRow label={t('lines')}>
                  <span className="tabular-nums">
                    {preview.files.reduce((sum, file) => sum + file.cards.reduce((n, card) => n + card.lines.length, 0), 0)}
                  </span>
                </SummaryRow>
              </SummaryList>
              {preview.pay.map((row) => (
                <p key={row.officerId} className="text-xs text-muted-foreground">
                  {t('pay', { name: row.officerName ?? '—', upper: preview.upper.unitCode })}
                </p>
              ))}
              {preview.mergesEnded.map((merge) => (
                <Alert key={merge.mergeId} variant="warning">
                  {t('mergeFinal', { survivor: merge.survivorName, absorbed: merge.absorbedName })}
                </Alert>
              ))}
            </section>

            {blockers.length === 0 ? (
              <div className="space-y-3">
                <Field label={t('area')} htmlFor="duplex-area" required>
                  <Input
                    id="duplex-area"
                    inputMode="decimal"
                    dir="ltr"
                    className="tabular-nums"
                    value={area}
                    disabled={submitting}
                    onChange={(event) => setArea(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {preview.areaAfter === null ? t('areaRequired') : t('areaHint')}
                  </p>
                </Field>
                <Field label={t('reason')} htmlFor="duplex-reason" required>
                  <Textarea
                    id="duplex-reason"
                    rows={2}
                    value={reason}
                    placeholder={t('reasonPlaceholder')}
                    disabled={submitting}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
                <Field label={t('confirm', { upper: preview.upper.unitCode })} htmlFor="duplex-code" required>
                  <Input
                    id="duplex-code"
                    dir="ltr"
                    className="font-mono"
                    autoComplete="off"
                    value={code}
                    disabled={submitting}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            {error ? (
              <Alert variant="destructive" live="alert">
                {error}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              {blockers.length === 0 ? (
                <Button variant="destructive" disabled={!canSubmit} onClick={() => void submit()}>
                  {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {t('submit')}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * «دمج مع الوحدة العلوية كدوبلكس…» under a selected flat. SUPER_ADMIN only, and
 * only when a flat stands directly above it (`upperFlatOf`) — the server asks
 * the same question again and refuses anything else.
 */
export function DuplexMergeButton({
  tenant,
  token,
  unitId,
  hasUpper,
  locale,
  disabled,
  onMerged,
}: {
  tenant: string;
  token: string;
  unitId: string;
  hasUpper: boolean;
  locale: string;
  disabled?: boolean;
  onMerged: (result: DuplexMergeResult) => void;
}): React.JSX.Element | null {
  const t = useTranslations('unitLevels.merge');
  const role = useStaffRole(tenant);
  const [open, setOpen] = React.useState(false);
  if (role !== 'SUPER_ADMIN' || !hasUpper) return null;
  return (
    <>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Layers className="size-4" aria-hidden />
        {t('button')}
      </Button>
      <DuplexMergeDialog
        open={open}
        onOpenChange={setOpen}
        tenant={tenant}
        token={token}
        unitId={unitId}
        locale={locale}
        onMerged={onMerged}
      />
    </>
  );
}
