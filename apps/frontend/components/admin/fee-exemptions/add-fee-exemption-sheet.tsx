'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import type { FeeExemptionUnitView } from '@mechanization/shared-schemas';
import { ApiRequestError, findFeeExemptionUnit, getCitizenFeeExemptionUnits, logApiError } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { CitizenPicker, type PickedCitizen } from '@/components/admin/citizen-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet } from '@/components/ui/sheet';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { FeeExemptionUnitCard } from './fee-exemption-unit-card';

type Mode = 'citizen' | 'reference';

/**
 * «إضافة إعفاء» — reaching the units to exempt (0104; the user's request of
 * 2026-11-16): from a person, every unit they own or occupy now, each with its
 * own exemption, granted or lifted one at a time; or one unit by its full code.
 * The exemption is the unit's: finding it through a person keys nothing to them.
 * There is no bulk grant in v1.
 */
export function AddFeeExemptionSheet({
  open,
  onClose,
  tenant,
  base,
  token,
  locale,
  canGrant,
}: {
  open: boolean;
  onClose: () => void;
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  canGrant: boolean;
}) {
  const t = useTranslations('feeExemptions');
  const tCommon = useTranslations('common');
  const [mode, setMode] = useState<Mode>('citizen');
  const [citizen, setCitizen] = useState<PickedCitizen | null>(null);
  const [reference, setReference] = useState('');
  const [found, setFound] = useState<FeeExemptionUnitView | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);

  const held = useStaffQuery({
    queryKey: ['fee-exemption-citizen', tenant, citizen?.id ?? ''],
    queryFn: (accessToken, signal) => getCitizenFeeExemptionUnits(tenant, accessToken, citizen!.id, signal),
    tenant,
    base,
    // Waits, as for any read, while there is no token: so nothing is read until a citizen is chosen.
    token: open && mode === 'citizen' && citizen !== null ? token : null,
    errorMessage: t('unitsError'),
  });

  /** One unit by its full code; re-read after a change through the same key the list moves. */
  const byReference = useStaffQuery({
    queryKey: ['fee-exemption-unit', tenant, 'reference', found?.reference ?? ''],
    queryFn: (accessToken, signal) => findFeeExemptionUnit(tenant, accessToken, found!.reference, signal),
    tenant,
    base,
    token: open && mode === 'reference' && found !== null ? token : null,
    errorMessage: t('unitLoadError'),
  });

  const find = async () => {
    if (!token || finding || reference.trim().length < 3) return;
    setFinding(true);
    setFindError(null);
    try {
      setFound(await findFeeExemptionUnit(tenant, token, reference.trim()));
    } catch (caught) {
      logApiError(caught);
      setFound(null);
      setFindError(caught instanceof ApiRequestError ? caught.message : t('unitLoadError'));
    } finally {
      setFinding(false);
    }
  };

  const shownByReference = byReference.data ?? found;

  return (
    <Sheet open={open} onClose={onClose} title={t('addTitle')} description={t('addDescription')} closeLabel={t('close')}>
      <div className="space-y-4">
        <SegmentedControl
          aria-label={t('addMode')}
          value={mode}
          onChange={(value) => setMode(value as Mode)}
          fullWidth
          options={[
            { value: 'citizen', label: t('fromCitizen') },
            { value: 'reference', label: t('byReference') },
          ]}
        />

        {mode === 'citizen' ? (
          <div className="space-y-3">
            <Field label={t('citizen')} htmlFor="fee-exemption-citizen">
              <CitizenPicker
                id="fee-exemption-citizen"
                tenant={tenant}
                token={token}
                value={citizen}
                onChange={setCitizen}
              />
            </Field>
            <p className="text-xs text-muted-foreground">{t('citizenHint')}</p>
            {citizen === null ? null : held.error && !held.data ? (
              <ErrorState compact title={held.error} onRetry={held.refetch} retryLabel={tCommon('retry')} />
            ) : held.loading || !held.data ? (
              <LoadingState compact label={t('unitsLoading')} />
            ) : held.data.units.length === 0 ? (
              <EmptyState compact title={t('noUnits')} />
            ) : (
              <div className="space-y-3">
                {held.data.units.map((unit) => (
                  <FeeExemptionUnitCard
                    key={unit.unitId}
                    tenant={tenant}
                    token={token}
                    locale={locale}
                    unit={unit}
                    role={unit.role}
                    canGrant={canGrant}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void find();
              }}
            >
              <Field label={t('reference')} htmlFor="fee-exemption-reference" className="min-w-0 flex-1">
                <Input
                  id="fee-exemption-reference"
                  dir="ltr"
                  className="font-mono"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder={t('referencePlaceholder')}
                  autoComplete="off"
                />
              </Field>
              <Button type="submit" variant="outline" disabled={finding || reference.trim().length < 3}>
                <Search className="size-4" aria-hidden />
                {t('find')}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('referenceHint')}</p>
            {findError ? (
              <Alert variant="destructive" live="alert">
                {findError}
              </Alert>
            ) : null}
            {shownByReference ? (
              <FeeExemptionUnitCard
                tenant={tenant}
                token={token}
                locale={locale}
                unit={shownByReference}
                canGrant={canGrant}
              />
            ) : null}
          </div>
        )}
      </div>
    </Sheet>
  );
}
