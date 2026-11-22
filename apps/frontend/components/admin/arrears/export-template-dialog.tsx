'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2 } from 'lucide-react';
import { ARREARS_EXPORT_MAX_CITIZENS, exportArrearsTemplateSchema } from '@mechanization/shared-schemas';
import { ApiRequestError, getParcelBuildings, getZones, logApiError } from '@/lib/api-client';
import { exportArrearsTemplate } from '@/lib/arrears-api';
import { buildArrearsTemplate, downloadCsv } from '@/lib/csv';
import { heldKey, markInDoubt, outcomeInDoubt, spendKey } from '@/lib/request-id';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Scope = 'ZONE' | 'BUILDING';

/**
 * «تصدير قالب» (old-debts-plan §4.1): the next N citizens of a zone or of one
 * building who are in no batch yet, as a CSV the accountant fills from the old
 * books. The server writes a DRAFT batch and its citizen set and returns the
 * rows; the browser writes the file (`buildArrearsTemplate`, every cell through
 * `csvCell`). Names, رقم العقار and unit codes only — never a رقم مرجعي, a phone
 * or an id number.
 *
 * The press carries a retry key held under `arrears:export` (`lib/request-id.ts`):
 * a lost answer pressed again is answered with the batch the first press made
 * (`replayed`), and the key is spent only once the server says the batch exists.
 */
export function ExportTemplateDialog({
  open,
  onOpenChange,
  tenant,
  base,
  token,
  onExported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  base: string;
  token: string | null;
  /** The draft the template belongs to: the page opens its import. */
  onExported: (batchId: string) => void;
}) {
  const t = useTranslations('arrears.export');
  const [scope, setScope] = useState<Scope>('ZONE');
  const [zoneId, setZoneId] = useState('');
  const [parcel, setParcel] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [count, setCount] = useState('50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const zones = useStaffQuery({
    queryKey: ['zones', tenant],
    queryFn: (session) => getZones(tenant, session),
    tenant,
    base,
    token: open ? token : null,
    errorMessage: t('zonesFailed'),
    reference: true,
  });
  const trimmedParcel = parcel.trim();
  const buildings = useStaffQuery({
    queryKey: ['parcel-buildings', tenant, trimmedParcel],
    queryFn: (session) => getParcelBuildings(tenant, session, trimmedParcel),
    tenant,
    base,
    token: open && scope === 'BUILDING' && trimmedParcel ? token : null,
    errorMessage: t('buildingsFailed'),
  });

  const input = exportArrearsTemplateSchema.safeParse({
    ...(scope === 'ZONE' ? { zoneId: zoneId || undefined } : { buildingId: buildingId || undefined }),
    count: Number(count),
    clientRequestId: heldKey(tenant, 'arrears:export'),
  });

  const run = async () => {
    if (!token || !input.success || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await exportArrearsTemplate(tenant, token, input.data);
      spendKey(tenant, 'arrears:export');
      downloadCsv(`arrears-${result.batchId.slice(0, 8)}.csv`, buildArrearsTemplate(result.rows));
      onExported(result.batchId);
      onOpenChange(false);
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.code === 'ARREARS_EXPORT_REQUEST_REUSED') {
        // The key made another export: that batch exists, so the next press is a new act.
        spendKey(tenant, 'arrears:export');
      } else if (outcomeInDoubt(caught)) {
        markInDoubt(tenant, 'arrears:export');
      }
      setError(caught instanceof ApiRequestError ? caught.message : t('failed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')} className="sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error ? (
            <Alert variant="destructive" live="alert">
              {error}
            </Alert>
          ) : null}

          <SegmentedControl
            aria-label={t('scope')}
            value={scope}
            onChange={(value) => setScope(value as Scope)}
            options={[
              { value: 'ZONE', label: t('byZone') },
              { value: 'BUILDING', label: t('byBuilding') },
            ]}
          />

          {scope === 'ZONE' ? (
            <Field label={t('zone')} htmlFor="arrears-export-zone" required error={zones.error ?? undefined}>
              <Select value={zoneId} onValueChange={setZoneId} disabled={zones.loading}>
                <SelectTrigger id="arrears-export-zone">
                  <SelectValue placeholder={t('choose')} />
                </SelectTrigger>
                <SelectContent>
                  {(zones.data?.zones ?? []).map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name} ({zone.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('parcel')} htmlFor="arrears-export-parcel" required>
                <Input
                  id="arrears-export-parcel"
                  value={parcel}
                  inputMode="numeric"
                  dir="ltr"
                  onChange={(event) => {
                    setParcel(event.target.value);
                    setBuildingId('');
                  }}
                />
              </Field>
              <Field label={t('building')} htmlFor="arrears-export-building" required error={buildings.error ?? undefined}>
                <Select value={buildingId} onValueChange={setBuildingId} disabled={!trimmedParcel || buildings.loading}>
                  <SelectTrigger id="arrears-export-building">
                    <SelectValue placeholder={buildings.data?.buildings.length === 0 ? t('noBuildings') : t('choose')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(buildings.data?.buildings ?? []).map((building) => (
                      <SelectItem key={building.id} value={building.id}>
                        <bdi dir="ltr">{building.code}</bdi>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}

          <Field
            label={t('count', { max: ARREARS_EXPORT_MAX_CITIZENS })}
            htmlFor="arrears-export-count"
            required
          >
            <Input
              id="arrears-export-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={ARREARS_EXPORT_MAX_CITIZENS}
              dir="ltr"
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
          </Field>
          <p className="text-sm text-muted-foreground">{t('privacy')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void run()} disabled={!input.success || busy || !token}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
            {busy ? t('busy') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
