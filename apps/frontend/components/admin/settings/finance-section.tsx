'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Coins, Smartphone } from 'lucide-react';
import {
  ApiRequestError,
  getMunicipalitySettings,
  logApiError,
  updateMunicipalitySettings,
} from '@/lib/api-client';
import type { MunicipalitySettings } from '@/lib/api-client';
import { CURRENCY_NAMES, type SettingsCopy } from '@/lib/settings-i18n';
import {
  CURRENCY_CODES as CURRENCIES,
  type CurrencyCode,
  type FeeFrequency,
} from '@mechanization/shared-schemas';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import {
  AlignedFieldGrid,
  SectionSaveRow,
  SettingsCard,
  FieldGroup,
  SettingsField,
} from './settings-ui';

/**
 * The finance form's working copy.
 */
interface FinanceDraft {
  whishMoneyNumber: string;
  defaultFrequency: FeeFrequency;
  dueDays: string;
  priceDisplay: 'compact' | 'exact';
  defaultRatePercent: string;
  baseCurrency: CurrencyCode;
  /** `''` is "none" — a municipality quoting only in LBP is the common case. */
  secondaryCurrency: CurrencyCode | '';
  exchangeRate: string;
  /** Read-only here: the server stamps it, and only when the rate changes. */
  exchangeRateUpdatedAt: string;
}

const EMPTY: FinanceDraft = {
  whishMoneyNumber: '',
  defaultFrequency: 'ANNUALLY',
  dueDays: '30',
  priceDisplay: 'compact',
  defaultRatePercent: '0',
  baseCurrency: 'LBP',
  secondaryCurrency: '',
  exchangeRate: '',
  exchangeRateUpdatedAt: '',
};

function toDraft(settings: MunicipalitySettings): FinanceDraft {
  return {
    whishMoneyNumber: settings.whishMoneyNumber ?? '',
    defaultFrequency: settings.defaultFeeFrequency,
    dueDays: String(settings.defaultDueDays),
    priceDisplay: settings.priceDisplay,
    defaultRatePercent: String(settings.defaultRatePercent),
    baseCurrency: settings.baseCurrency,
    secondaryCurrency: settings.secondaryCurrency ?? '',
    exchangeRate: settings.exchangeRate === null ? '' : String(settings.exchangeRate),
    exchangeRateUpdatedAt: settings.exchangeRateUpdatedAt ?? '',
  };
}

/** `'12.5'` → `12.5`, and anything unparseable → `null`. */
function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(amount: number, currency: CurrencyCode): string {
  const digits = currency === 'LBP' ? 0 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * المالية — what a new invoice assumes before anyone edits it.
 */
export function FinanceSection({
  tenant,
  token,
  locale,
  copy,
}: {
  tenant: string;
  token: string;
  locale: string;
  copy: SettingsCopy;
}) {
  const toast = useToast();

  const [saved, setSaved] = useState<FinanceDraft | null>(null);
  const [local, setLocal] = useState<FinanceDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getMunicipalitySettings(tenant, token);
        if (cancelled) return;
        const next = toDraft(result);
        setSaved(next);
        setLocal(next);
        setError(null);
      } catch (caught) {
        logApiError(caught);
        if (!cancelled) {
          setError(caught instanceof ApiRequestError ? caught.message : copy.common.loadError);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant, token, copy.common.loadError]);

  const exchange = parseNumber(local.exchangeRate);
  const exchangeValid = !local.secondaryCurrency || (exchange !== null && exchange > 0);
  const dueDays = parseNumber(local.dueDays);
  const dueDaysValid = dueDays !== null && Number.isInteger(dueDays) && dueDays >= 0 && dueDays <= 365;

  const dirty = useMemo(
    () => saved !== null && JSON.stringify(local) !== JSON.stringify(saved),
    [local, saved],
  );

  const save = useCallback(async () => {
    if (!exchangeValid) {
      toast.error(copy.finance.invalidExchange);
      return;
    }
    if (!dueDaysValid) {
      toast.error(copy.finance.invalidDueDays);
      return;
    }

    setSaving(true);
    try {
      const result = await updateMunicipalitySettings(tenant, token, {
        whishMoneyNumber: local.whishMoneyNumber,
        defaultFeeFrequency: local.defaultFrequency,
        defaultDueDays: dueDays,
        priceDisplay: local.priceDisplay,
        defaultRatePercent: Number(local.defaultRatePercent) || 0,
        baseCurrency: local.baseCurrency,
        secondaryCurrency: local.secondaryCurrency === '' ? null : local.secondaryCurrency,
        exchangeRate: local.secondaryCurrency === '' ? null : exchange,
      });
      const next = toDraft(result);
      setSaved(next);
      setLocal(next);
      toast.success(copy.common.saved);
      setError(null);
    } catch (caught) {
      logApiError(caught);
      const message = caught instanceof ApiRequestError ? caught.message : copy.common.saveError;
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [
    tenant,
    token,
    local,
    exchange,
    dueDays,
    exchangeValid,
    dueDaysValid,
    toast,
    copy,
  ]);

  const discard = useCallback(() => {
    if (saved) setLocal(saved);
  }, [saved]);

  const currencyNames = CURRENCY_NAMES[locale === 'en' ? 'en' : 'ar'];

  if (loading) {
    return <Skeleton className="h-[34rem] rounded-lg" />;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <SettingsCard icon={Coins} title={copy.finance.title} hint={copy.finance.description}>
        <div className="space-y-5">
          <FieldGroup icon={Coins} title={copy.finance.defaultsHeading}>
            <AlignedFieldGrid>
              <SettingsField
                label={copy.finance.dueDays}
                htmlFor="due-days"
                error={dueDaysValid ? undefined : copy.finance.invalidDueDays}
              >
                <Input
                  id="due-days"
                  inputMode="numeric"
                  dir="ltr"
                  invalid={!dueDaysValid}
                  className="text-start"
                  value={local.dueDays}
                  onChange={(e) =>
                    setLocal({ ...local, dueDays: e.target.value.replace(/\D/g, '') })
                  }
                />
              </SettingsField>

              <SettingsField
                label={copy.finance.priceDisplay}
                htmlFor="price-display"
              >
                <Select
                  value={local.priceDisplay}
                  onValueChange={(next) =>
                    setLocal({ ...local, priceDisplay: next as FinanceDraft['priceDisplay'] })
                  }
                >
                  <SelectTrigger id="price-display">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="compact">{copy.finance.priceDisplayCompact}</SelectItem>
                    <SelectItem value="exact">{copy.finance.priceDisplayExact}</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsField>
            </AlignedFieldGrid>
          </FieldGroup>

          <FieldGroup icon={ArrowLeftRight} title={copy.finance.currencyHeading}>
            <AlignedFieldGrid>
              <SettingsField
                label={copy.finance.baseCurrency}
                htmlFor="base-currency"
              >
                <Select
                  value={local.baseCurrency}
                  onValueChange={(next) => setLocal({ ...local, baseCurrency: next as CurrencyCode })}
                >
                  <SelectTrigger id="base-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((code) => (
                      <SelectItem key={code} value={code}>
                        {currencyNames[code]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>

              <SettingsField
                label={copy.finance.secondaryCurrency}
                htmlFor="secondary-currency"
              >
                <Select
                  value={local.secondaryCurrency || 'NONE'}
                  onValueChange={(next) =>
                    setLocal({
                      ...local,
                      secondaryCurrency: next === 'NONE' ? '' : (next as CurrencyCode),
                    })
                  }
                >
                  <SelectTrigger id="secondary-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">{copy.finance.secondaryNone}</SelectItem>
                    {CURRENCIES.filter((code) => code !== local.baseCurrency).map((code) => (
                      <SelectItem key={code} value={code}>
                        {currencyNames[code]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
            </AlignedFieldGrid>

            {local.secondaryCurrency ? (
              <div className="mt-3 grid items-start gap-5">
                <div>
                  <SettingsField
                    label={copy.finance.exchangeRate}
                    htmlFor="exchange-rate"
                    error={exchangeValid ? undefined : copy.finance.invalidExchange}
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-md bg-muted px-2.5 py-2 text-xs font-semibold text-muted-foreground" dir="ltr">
                        1 {local.secondaryCurrency} =
                      </span>
                      <Input
                        id="exchange-rate"
                        inputMode="decimal"
                        dir="ltr"
                        invalid={!exchangeValid}
                        className="text-start font-mono font-medium"
                        value={local.exchangeRate}
                        onChange={(e) => setLocal({ ...local, exchangeRate: e.target.value })}
                      />
                      <span className="shrink-0 rounded-md bg-muted px-2.5 py-2 text-xs font-semibold text-muted-foreground">
                        {local.baseCurrency}
                      </span>
                    </div>
                  </SettingsField>
                </div>

                <div>
                  <SettingsField
                    label={copy.finance.conversionPreview}
                    htmlFor="conversion-preview"
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-md bg-muted px-2.5 py-2 text-xs font-semibold text-muted-foreground" dir="ltr">
                        {local.baseCurrency === 'LBP' ? '1,000,000' : '1'} {local.baseCurrency} =
                      </span>
                      <Input
                        id="conversion-preview"
                        readOnly
                        dir="ltr"
                        tabIndex={-1}
                        className="text-start font-mono font-medium bg-muted/40 cursor-default"
                        value={
                          exchangeValid && exchange
                            ? formatNumber(
                                (local.baseCurrency === 'LBP' ? 1_000_000 : 1) / exchange,
                                local.secondaryCurrency,
                              )
                            : '—'
                        }
                      />
                      <span className="shrink-0 rounded-md bg-muted px-2.5 py-2 text-xs font-semibold text-muted-foreground">
                        {local.secondaryCurrency}
                      </span>
                    </div>
                  </SettingsField>
                </div>
              </div>
            ) : null}
          </FieldGroup>

          <FieldGroup icon={Smartphone} title={copy.finance.whishHeading}>
            <AlignedFieldGrid>
              <SettingsField
                label={copy.finance.whishNumber}
                htmlFor="whish-number"
              >
                <Input
                  id="whish-number"
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  className="text-start"
                  value={local.whishMoneyNumber}
                  onChange={(e) => setLocal({ ...local, whishMoneyNumber: e.target.value })}
                />
              </SettingsField>
            </AlignedFieldGrid>
          </FieldGroup>
        </div>

        <SectionSaveRow
          copy={copy}
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onDiscard={discard}
        />
      </SettingsCard>
    </div>
  );
}
