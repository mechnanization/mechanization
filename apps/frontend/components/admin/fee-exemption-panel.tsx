'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BadgeCheck, Loader2 } from 'lucide-react';
import {
  FEE_EXEMPTION_REASON,
  getLabels,
  isStructuralUnitType,
  type FeeExemptionReason,
  type SetUnitFeeExemptionInput,
} from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { UnitWithOccupants } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';

/**
 * «معفاة من الرسوم» on one unit (migration 0077): the mosque on a waqf parcel, a
 * public building — charged nothing, whoever bears the fee (the user's
 * decision, 2026-10-07).
 *
 * Everyone sees an exemption that stands, with its reason, date and grantor;
 * only a SUPER_ADMIN (`canGrant`) grants or lifts one, and the server refuses
 * anyone else. A unit somebody rents or lives in rent-free is warned about:
 * exempting it exempts them too, while a shop a waqf rents out is billed to its
 * tenant as usual.
 */
export function FeeExemptionPanel({
  unit,
  locale,
  busy,
  canGrant,
  onSave,
}: {
  unit: UnitWithOccupants;
  locale: string;
  busy: boolean;
  canGrant: boolean;
  onSave: (input: SetUnitFeeExemptionInput) => void;
}) {
  const t = useTranslations('feeExemption');
  const labels = getLabels(locale);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<FeeExemptionReason | ''>('');
  const [note, setNote] = useState('');
  const [confirmLift, setConfirmLift] = useState(false);

  useEffect(() => {
    setOpen(false);
    setReason('');
    setNote('');
  }, [unit.id, unit.feeExemption]);

  if (isStructuralUnitType(unit.unitType)) return null;

  if (unit.feeExemption) {
    return (
      <div className="space-y-2 rounded-md border border-success/30 bg-success/5 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <BadgeCheck className="size-3.5 text-success" aria-hidden />
          {t('standing', { reason: labels.feeExemptionReason[unit.feeExemption] })}
        </p>
        {unit.feeExemptionNote ? <p className="text-xs">{unit.feeExemptionNote}</p> : null}
        <p className="text-xs text-muted-foreground">
          {t('grantedBy', {
            date: unit.feeExemptedAt ? formatDate(unit.feeExemptedAt) : '—',
            name: unit.feeExemptedByName ?? t('unknownGrantor'),
          })}
        </p>
        {canGrant ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmLift(true)}>
              {t('lift')}
            </Button>
            <ConfirmDialog
              open={confirmLift}
              onOpenChange={setConfirmLift}
              title={t('liftTitle', { code: unit.unitCode })}
              description={t('liftBody')}
              confirmLabel={t('lift')}
              cancelLabel={t('cancel')}
              onConfirm={() => {
                setConfirmLift(false);
                onSave({ reason: null });
              }}
            />
          </>
        ) : null}
      </div>
    );
  }

  if (!canGrant) return null;

  const occupied = unit.occupants.some(
    (occupant) => occupant.toDate === null && (occupant.role === 'TENANT' || occupant.role === 'FREE_OCCUPANT'),
  );
  const noteMissing = reason === 'OTHER' && note.trim().length < 3;

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="px-0 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <BadgeCheck className="size-3.5 text-muted-foreground" aria-hidden />
          {t('title')}
        </p>
        <p className="text-xs text-muted-foreground">{t('intro')}</p>
        {occupied ? <p className="text-xs text-warning">{t('occupiedWarning')}</p> : null}
      </div>
      <Field label={t('reason')} htmlFor={`fee-exemption-reason-${unit.id}`} required>
        <Select value={reason} onValueChange={(value) => setReason(value as FeeExemptionReason)} disabled={busy}>
          <SelectTrigger id={`fee-exemption-reason-${unit.id}`}>
            <SelectValue placeholder={t('reasonPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {FEE_EXEMPTION_REASON.map((value) => (
              <SelectItem key={value} value={value}>
                {labels.feeExemptionReason[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t('note')}
        htmlFor={`fee-exemption-note-${unit.id}`}
        required={reason === 'OTHER'}
        error={noteMissing && note !== '' ? t('noteRequired') : undefined}
      >
        <Textarea
          id={`fee-exemption-note-${unit.id}`}
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('notePlaceholder')}
          disabled={busy}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !reason || noteMissing}
          onClick={() => reason && onSave({ reason, ...(note.trim() ? { note: note.trim() } : {}) })}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('grant')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
