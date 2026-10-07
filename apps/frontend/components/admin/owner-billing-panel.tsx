'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Scale } from 'lucide-react';
import {
  getLabels,
  OWNER_BILLING_MODE,
  ownerSharesPreview,
  type OwnerBillingMode,
  type OwnerShareOutcome,
  type SetOwnerBillingInput,
} from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CitizenProfileUnit, UnitOccupant, UnitWithOccupants } from '@/lib/api-client';

/** أسهم as typed: a whole number from 1 to 2400, or nothing usable. */
function parseShares(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const shares = Number(value.trim());
  return shares >= 1 && shares <= 2400 ? shares : null;
}

/** The flat's current owners, one per person, oldest record first. */
export function currentOwners(unit: UnitWithOccupants): UnitOccupant[] {
  const seen = new Set<string>();
  return unit.occupants
    .filter((occupant) => occupant.toDate === null && occupant.role === 'OWNER')
    .sort((a, b) => ((a.recordedAt ?? a.fromDate) < (b.recordedAt ?? b.fromDate) ? -1 : 1))
    .filter((occupant) => (seen.has(occupant.citizenId) ? false : (seen.add(occupant.citizenId), true)));
}

/**
 * Whether the drawer shows «توزيع الرسم على المالكين» for this unit: a flat with
 * several owners, or one that lost its co-owners and still carries a choice
 * somebody should withdraw.
 */
export function showsOwnerBilling(unit: UnitWithOccupants): boolean {
  return currentOwners(unit).length > 1 || Boolean(unit.ownerBillingMode);
}

/**
 * «توزيع الرسم على المالكين» — how a flat several people own is billed
 * (migration 0075; the user's decision, 2026-10-07): split equally (the
 * default), by أسهم, or by one owner who pays for all.
 *
 * The preview runs `ownerSharesPreview`, the rule billing applies, over what
 * is on the screen — so what an officer reads here before saving is exactly
 * what each owner's next bill will charge. It only divides what the owners
 * owe; a tenant's occupancy fee is never divided, and the panel says so.
 */
export function OwnerBillingPanel({
  unit,
  locale,
  busy,
  canWrite,
  onSave,
}: {
  unit: UnitWithOccupants;
  locale: string;
  busy: boolean;
  canWrite: boolean;
  /** `withdraw` saves `mode: null` — back to the equal split. */
  onSave: (input: SetOwnerBillingInput, kind: 'save' | 'withdraw') => void;
}) {
  const t = useTranslations('ownerBilling');
  const labels = getLabels(locale);
  const owners = useMemo(() => currentOwners(unit), [unit]);
  const ownersKey = owners.map((owner) => `${owner.citizenId}:${owner.shares ?? ''}`).join('|');

  const [mode, setMode] = useState<OwnerBillingMode>(unit.ownerBillingMode ?? 'EQUAL');
  const [responsible, setResponsible] = useState(unit.responsibleOwnerId ?? '');
  const [shares, setShares] = useState<Record<string, string>>({});

  useEffect(() => {
    setMode(unit.ownerBillingMode ?? 'EQUAL');
    setResponsible(unit.responsibleOwnerId ?? '');
    setShares(Object.fromEntries(owners.map((owner) => [owner.citizenId, owner.shares ? String(owner.shares) : ''])));
    // `ownersKey` stands for the owners and their أسهم; `owners` itself is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id, unit.ownerBillingMode, unit.responsibleOwnerId, ownersKey]);

  const nameOf = (owner: UnitOccupant) => owner.citizenName ?? t('unnamed');

  const draftShares = (citizenId: string, stored: number | null) =>
    mode === 'BY_SHARES' ? parseShares(shares[citizenId] ?? '') : stored;

  const preview = ownerSharesPreview({
    mode,
    responsibleOwnerId: mode === 'RESPONSIBLE_OWNER' ? responsible || null : null,
    owners: owners.map((owner) => ({ citizenId: owner.citizenId, shares: draftShares(owner.citizenId, owner.shares) })),
  });

  // A choice saved on a flat that has since lost its co-owners: offer to withdraw it, nothing else.
  if (owners.length < 2) {
    if (!unit.ownerBillingMode) return null;
    return (
      <div className="space-y-2 rounded-md border p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Scale className="size-3.5 text-muted-foreground" aria-hidden />
          {t('title')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('singleOwner', { mode: labels.ownerBillingMode[unit.ownerBillingMode] })}
        </p>
        {canWrite ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave({ mode: null }, 'withdraw')}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t('withdraw')}
          </Button>
        ) : null}
      </div>
    );
  }

  const missingShares = mode === 'BY_SHARES' && owners.some((owner) => parseShares(shares[owner.citizenId] ?? '') === null);
  const missingResponsible = mode === 'RESPONSIBLE_OWNER' && !owners.some((owner) => owner.citizenId === responsible);
  const unchanged =
    unit.ownerBillingMode === mode &&
    (mode !== 'RESPONSIBLE_OWNER' || unit.responsibleOwnerId === responsible) &&
    (mode !== 'BY_SHARES' ||
      owners.every((owner) => parseShares(shares[owner.citizenId] ?? '') === owner.shares));

  const partOf = (outcome: OwnerShareOutcome): string => {
    if (outcome.kind === 'WHOLE') return t('partWhole');
    if (outcome.kind === 'UNDECIDABLE') return t('partUnknown');
    const { numerator, denominator } = outcome.share;
    if (numerator === 0) return t('partNone');
    if (numerator === denominator) return t('partWhole');
    return t('partFraction', { numerator, denominator });
  };

  const save = () => {
    const input: SetOwnerBillingInput = { mode };
    if (mode === 'RESPONSIBLE_OWNER') input.responsibleOwnerId = responsible;
    if (mode === 'BY_SHARES') {
      input.shares = owners.map((owner) => ({
        citizenId: owner.citizenId,
        shares: parseShares(shares[owner.citizenId] ?? '') as number,
      }));
    }
    onSave(input, 'save');
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Scale className="size-3.5 text-muted-foreground" aria-hidden />
          {t('title')}
        </p>
        <p className="text-xs text-muted-foreground">{t('intro', { count: owners.length })}</p>
        {!unit.ownerBillingMode ? <p className="text-xs text-muted-foreground">{t('defaultNote')}</p> : null}
        {preview.effective.fallback === 'RESPONSIBLE_NOT_OWNER' && mode === unit.ownerBillingMode ? (
          <p className="text-xs text-warning">{t('fallback')}</p>
        ) : null}
      </div>

      <div className="grid gap-3">
        <Field label={t('modeLabel')} htmlFor={`owner-billing-mode-${unit.id}`} required>
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as OwnerBillingMode)}
            disabled={!canWrite || busy}
          >
            <SelectTrigger id={`owner-billing-mode-${unit.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OWNER_BILLING_MODE.map((value) => (
                <SelectItem key={value} value={value}>
                  {labels.ownerBillingMode[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {mode === 'RESPONSIBLE_OWNER' ? (
          <Field label={t('responsibleLabel')} htmlFor={`owner-billing-responsible-${unit.id}`} required>
            <Select value={responsible} onValueChange={setResponsible} disabled={!canWrite || busy}>
              <SelectTrigger id={`owner-billing-responsible-${unit.id}`}>
                <SelectValue placeholder={t('responsiblePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {owners.map((owner) => (
                  <SelectItem key={owner.citizenId} value={owner.citizenId}>
                    {nameOf(owner)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {mode === 'BY_SHARES' ? (
          <fieldset className="space-y-2" disabled={!canWrite || busy}>
            <legend className="text-xs font-medium">{t('sharesLegend')}</legend>
            <p className="text-xs text-muted-foreground">{t('sharesHint')}</p>
            {owners.map((owner) => {
              const id = `owner-billing-shares-${unit.id}-${owner.citizenId}`;
              const value = shares[owner.citizenId] ?? '';
              return (
                <Field
                  key={owner.citizenId}
                  label={t('sharesFor', { name: nameOf(owner) })}
                  htmlFor={id}
                  required
                  error={value !== '' && parseShares(value) === null ? t('sharesInvalid') : undefined}
                >
                  <Input
                    id={id}
                    inputMode="numeric"
                    dir="ltr"
                    className="text-start"
                    value={value}
                    onChange={(event) => setShares((current) => ({ ...current, [owner.citizenId]: event.target.value }))}
                  />
                </Field>
              );
            })}
          </fieldset>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">{t('previewTitle')}</p>
        <ul className="space-y-1">
          {preview.owners.map((entry) => {
            const owner = owners.find((candidate) => candidate.citizenId === entry.citizenId)!;
            return (
              <li key={entry.citizenId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                <span className="font-medium">{nameOf(owner)}</span>
                <span className="text-muted-foreground">{partOf(entry.outcome)}</span>
                {owner.backedByFile === false ? (
                  <span className="basis-full text-warning">{t('notOnFile')}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">{t('tenantNote')}</p>
      </div>

      {canWrite ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || missingShares || missingResponsible || unchanged}
          onClick={save}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One owner's billing on a co-owned flat, as their file says it: the method in
 * force and their part of it. `mine` words it to the citizen themselves, on
 * the portal.
 */
export function OwnerBillingSummary({
  billing,
  locale,
  perspective,
}: {
  billing: NonNullable<CitizenProfileUnit['ownerBilling']>;
  locale: string;
  perspective: 'file' | 'mine';
}) {
  const t = useTranslations('ownerBilling');
  const labels = getLabels(locale);
  const mine = perspective === 'mine';
  const part = (() => {
    if (!billing.share) return t('fileUnknown');
    const { numerator, denominator } = billing.share;
    if (billing.effectiveMode === 'RESPONSIBLE_OWNER') {
      if (numerator === 0) return mine ? t('minePaysNone') : t('filePaysNone');
      return mine ? t('minePaysAll') : t('filePaysAll');
    }
    return mine ? t('mineShare', { numerator, denominator }) : t('fileShare', { numerator, denominator });
  })();
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span>{billing.mode ? labels.ownerBillingMode[billing.effectiveMode] : t('fileDefault')}</span>
      <span className="text-xs text-muted-foreground">{part}</span>
      {billing.fallback === 'RESPONSIBLE_NOT_OWNER' ? (
        <span className="text-xs text-warning">{t('fallback')}</span>
      ) : null}
    </span>
  );
}
