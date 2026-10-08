'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Scale } from 'lucide-react';
import {
  getLabels,
  normalizeDigits,
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
import type { UnitOccupant, UnitWithOccupants } from '@/lib/api-client';
import {
  archivedOwners,
  currentOwners,
  ownerBillingWording,
  parseShares,
  type OwnerBillingView,
} from '@/lib/owner-billing';

/** The أسهم boxes as the officer left them, one per owner — what the record holds until they type. */
function storedShares(owners: readonly UnitOccupant[]): Record<string, string> {
  return Object.fromEntries(owners.map((owner) => [owner.citizenId, owner.shares ? String(owner.shares) : '']));
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
 * Whether it shows at all is `showsOwnerBilling` (`lib/owner-billing.ts`).
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
  const archived = useMemo(() => archivedOwners(unit), [unit]);
  const ownersKey = owners.map((owner) => `${owner.citizenId}:${owner.shares ?? ''}`).join('|');

  const [mode, setMode] = useState<OwnerBillingMode>(unit.ownerBillingMode ?? 'EQUAL');
  const [responsible, setResponsible] = useState(unit.responsibleOwnerId ?? '');
  // Filled from the record on the first render, not after it: the boxes never flash empty.
  const [shares, setShares] = useState<Record<string, string>>(() => storedShares(owners));
  /** Boxes the officer has left — checked on blur, not per keystroke (FRM-2). */
  const [left, setLeft] = useState<Record<string, boolean>>({});
  /** A save was pressed with a box still wrong: every box says so now. */
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setMode(unit.ownerBillingMode ?? 'EQUAL');
    setResponsible(unit.responsibleOwnerId ?? '');
    setShares(storedShares(owners));
    setLeft({});
    setSubmitted(false);
    // `ownersKey` stands for the owners and their أسهم; `owners` itself is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id, unit.ownerBillingMode, unit.responsibleOwnerId, ownersKey]);

  const nameOf = (owner: UnitOccupant) => owner.citizenName ?? t('unnamed');
  /*
    The archived owners, each name isolated (RTL-2) and joined with the
    locale's separator: an Arabic name in an English sentence, or a Latin one
    in an Arabic sentence, must not reorder the words around it.
  */
  const archivedLine =
    archived.length > 0 ? (
      <p className="text-xs text-warning">
        {t.rich('archivedOwners', {
          names: () =>
            archived.map((owner, index) => (
              <Fragment key={owner.citizenId}>
                {index > 0 ? t('listSeparator') : null}
                <bdi>{nameOf(owner)}</bdi>
              </Fragment>
            )),
        })}
      </p>
    ) : null;

  const draftShares = (citizenId: string, stored: number | null) =>
    mode === 'BY_SHARES' ? parseShares(shares[citizenId] ?? '') : stored;

  const preview = ownerSharesPreview({
    mode,
    responsibleOwnerId: mode === 'RESPONSIBLE_OWNER' ? responsible || null : null,
    owners: owners.map((owner) => ({ citizenId: owner.citizenId, shares: draftShares(owner.citizenId, owner.shares) })),
  });

  /*
    A choice saved on a flat that has since lost its co-owners: offer to
    withdraw it, nothing else — and say why there is one owner left when the
    others are archived rather than gone.
  */
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
        {archivedLine}
        {canWrite ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave({ mode: null }, 'withdraw')}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t('withdraw')}
          </Button>
        ) : null}
      </div>
    );
  }

  const sharesIdOf = (citizenId: string) => `owner-billing-shares-${unit.id}-${citizenId}`;
  const invalidShares = mode === 'BY_SHARES' ? owners.filter((owner) => parseShares(shares[owner.citizenId] ?? '') === null) : [];
  const missingResponsible = mode === 'RESPONSIBLE_OWNER' && !owners.some((owner) => owner.citizenId === responsible);
  // No choice saved bills as «بالتساوي»; saving that explicitly would change no bill.
  const unchanged =
    (unit.ownerBillingMode ?? 'EQUAL') === mode &&
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
    // FRM-2: a failed submit says what is wrong under each box and puts the officer in the first one.
    if (invalidShares.length > 0) {
      setSubmitted(true);
      document.getElementById(sharesIdOf(invalidShares[0]!.citizenId))?.focus();
      return;
    }
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
        {archivedLine}
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
                {/*
                  An owner whose own file does not claim the flat cannot pay for
                  it — billing would charge nobody, and the server refuses it
                  (OWNER_BILLING_RESPONSIBLE_NOT_BILLED). Offered, but not
                  choosable, with the reason beside the name.
                */}
                {owners.map((owner) => (
                  <SelectItem key={owner.citizenId} value={owner.citizenId} disabled={owner.backedByFile === false}>
                    {nameOf(owner)}
                    {owner.backedByFile === false ? (
                      <span className="ms-2 text-xs text-muted-foreground">{t('notOnFileOption')}</span>
                    ) : null}
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
              const id = sharesIdOf(owner.citizenId);
              const value = shares[owner.citizenId] ?? '';
              // Judged once the box is left with something in it, or on a save — never mid-typing (FRM-2).
              const wrong =
                (submitted || (left[owner.citizenId] && value.trim() !== '')) && parseShares(value) === null;
              return (
                <Field
                  key={owner.citizenId}
                  label={t('sharesFor', { name: nameOf(owner) })}
                  htmlFor={id}
                  required
                  error={wrong ? t('sharesInvalid') : undefined}
                >
                  <Input
                    id={id}
                    inputMode="numeric"
                    dir="ltr"
                    className="text-start"
                    value={value}
                    invalid={wrong}
                    onChange={(event) => setShares((current) => ({ ...current, [owner.citizenId]: event.target.value }))}
                    // «١٢٠٠» typed on an Arabic keyboard is shown back as 1200, the digits the rest of the screen uses (TYP-4).
                    onBlur={() => {
                      setShares((current) => ({ ...current, [owner.citizenId]: normalizeDigits(value).trim() }));
                      setLeft((current) => ({ ...current, [owner.citizenId]: true }));
                    }}
                  />
                </Field>
              );
            })}
          </fieldset>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">{t('previewTitle')}</p>
        {missingResponsible ? (
          // No owner picked yet: an equal split here would preview a choice nobody made.
          <p className="text-xs text-muted-foreground">{t('pickResponsible')}</p>
        ) : (
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
        )}
        <p className="text-xs text-muted-foreground">{t('tenantNote')}</p>
      </div>

      {canWrite ? (
        <Button size="sm" variant="outline" disabled={busy || missingResponsible || unchanged} onClick={save}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One owner's billing on a co-owned flat, as their file shows it to staff: the
 * method in force and their part of it. The citizen's own «ملفّي» says the
 * same through the same helper (`ownerBillingWording`), worded to them.
 */
export function OwnerBillingSummary({ billing, locale }: { billing: OwnerBillingView; locale: string }) {
  const wording = ownerBillingWording(billing, locale, 'file');
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span>{wording.method}</span>
      <span className="text-xs text-muted-foreground">{wording.part}</span>
      {wording.fallback ? <span className="text-xs text-warning">{wording.fallback}</span> : null}
    </span>
  );
}
