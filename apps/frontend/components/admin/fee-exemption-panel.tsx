'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BadgeCheck, CalendarX } from 'lucide-react';
import {
  feeExemptionEndedOn,
  getLabels,
  isStructuralUnitType,
  municipalToday,
  type SetUnitFeeExemptionInput,
} from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import type { UnitWithOccupants } from '@/lib/api-client';
import { formatDate, formatDay } from '@/lib/dates';
import { FeeExemptionForm } from './fee-exemptions/fee-exemption-form';
import { LiftFeeExemptionDialog } from './fee-exemptions/lift-fee-exemption-dialog';

/**
 * «معفاة من الرسوم» on one unit (migrations 0077, 0104): the mosque on a waqf
 * parcel, a public building — charged nothing, whoever bears the fee (the
 * user's decisions of 2026-10-07 and 2026-11-16).
 *
 * Everyone sees an exemption that stands, with its reason, its last day and
 * who granted it; one past its last day says it is billed again. Only the
 * manager (`canGrant`, `FEE_EXEMPTION_GRANT_ROLES`) grants or lifts one, a lift
 * with its reason, and the server refuses anyone else. The decision number and
 * the unit's whole history are on «قائمة الإعفاء من الرسوم» (`whitelistHref`).
 */
export function FeeExemptionPanel({
  unit,
  locale,
  busy,
  canGrant,
  whitelistHref,
  onSave,
}: {
  unit: UnitWithOccupants;
  locale: string;
  busy: boolean;
  canGrant: boolean;
  /** The whitelist page, for readers allowed to open it; omitted otherwise. */
  whitelistHref?: string;
  onSave: (input: SetUnitFeeExemptionInput) => void;
}) {
  const t = useTranslations('feeExemption');
  const labels = getLabels(locale);
  const [open, setOpen] = useState(false);
  const [confirmLift, setConfirmLift] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [unit.id, unit.feeExemption]);

  if (isStructuralUnitType(unit.unitType)) return null;

  if (unit.feeExemption) {
    const validUntil = unit.feeExemptionValidUntil ?? null;
    const ended = feeExemptionEndedOn({ feeExemption: unit.feeExemption, feeExemptionValidUntil: validUntil }, municipalToday());
    return (
      <div
        className={
          ended
            ? 'space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3'
            : 'space-y-2 rounded-md border border-success/30 bg-success/5 p-3'
        }
      >
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          {ended ? (
            <CalendarX className="size-3.5 text-warning" aria-hidden />
          ) : (
            <BadgeCheck className="size-3.5 text-success" aria-hidden />
          )}
          {t('standing', { reason: labels.feeExemptionReason[unit.feeExemption] })}
        </p>
        {unit.feeExemptionNote ? <p className="text-xs">{unit.feeExemptionNote}</p> : null}
        <p className={ended ? 'text-xs font-medium text-warning' : 'text-xs text-muted-foreground'}>
          {ended
            ? t('ended', { date: formatDay(validUntil!) })
            : validUntil
              ? t('standingUntil', { date: formatDay(validUntil) })
              : t('noEnd')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('grantedBy', {
            date: unit.feeExemptedAt ? formatDate(unit.feeExemptedAt) : '—',
            name: unit.feeExemptedByName ?? t('unknownGrantor'),
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canGrant ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmLift(true)}>
              {t('lift')}
            </Button>
          ) : null}
          {whitelistHref ? (
            <Button asChild size="sm" variant="ghost" className="px-0 text-xs">
              <Link href={whitelistHref}>{t('whitelistLink')}</Link>
            </Button>
          ) : null}
        </div>
        {canGrant ? (
          <LiftFeeExemptionDialog
            open={confirmLift}
            onOpenChange={setConfirmLift}
            idPrefix={`fee-exemption-${unit.id}`}
            unitCode={unit.unitCode}
            onConfirm={(liftReason) => {
              setConfirmLift(false);
              onSave({ reason: null, liftReason });
            }}
          />
        ) : null}
      </div>
    );
  }

  if (!canGrant) return null;

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="px-0 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
    );
  }

  const occupied = unit.occupants.some(
    (occupant) => occupant.toDate === null && (occupant.role === 'TENANT' || occupant.role === 'FREE_OCCUPANT'),
  );
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <BadgeCheck className="size-3.5 text-muted-foreground" aria-hidden />
        {t('title')}
      </p>
      <FeeExemptionForm
        idPrefix={`fee-exemption-${unit.id}`}
        locale={locale}
        busy={busy}
        occupied={occupied}
        submitLabel={t('grant')}
        onSubmit={onSave}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
