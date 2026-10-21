'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CirclePause, CirclePlay, Pencil, Tags } from 'lucide-react';
import { getLabels, updateRequestTypeSettingSchema, type RequestType } from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { getRequestTypes, updateRequestType, type RequestTypeSettingView } from '@/lib/requests-api';
import { hasRole, REQUEST_SETTINGS_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';

/**
 * «أنواع الطلبات والرسوم» — which municipal requests the municipality offers,
 * and the fee of each (open decisions §20 D1): in Lebanese pounds, whole, and 0
 * for free. The fee a request is billed is the one set here when its bill is
 * raised; a request already billed keeps its bill.
 *
 * Every type is listed, stopped ones included: a stopped type leaves the
 * counter form and the portal, never the requests already filed under it. The
 * manager (`REQUEST_SETTINGS_ROLES`) sets the fee in an editor above the list,
 * read against the list beneath it rather than in a dialog that would cover it
 * (BAN-10), and stops or restarts a type in one reversible press (DES-2).
 * Everyone who may read the queue may read this list; the server enforces the
 * same (CODE-4).
 */
export default function RequestTypesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('requests.types');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { token, user } = useStaffSession(tenant, base);
  const canManage = user ? hasRole(REQUEST_SETTINGS_ROLES, user.role) : false;

  /**
   * The type whose fee is being edited — its type only. The editor reads the row's
   * current values from the list, so a stop or restart made since it opened is what
   * it saves, never the snapshot it opened with.
   */
  const [editing, setEditing] = useState<RequestType | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const toggleInFlight = useRef(false);

  const query = useStaffQuery({
    queryKey: ['requests', tenant, 'types'],
    queryFn: (accessToken, signal) => getRequestTypes(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const types = useMemo(() => query.data ?? [], [query.data]);
  const edited = editing ? types.find((setting) => setting.requestType === editing) : undefined;

  /** The answer is the whole list: it replaces the cache, and the queue's reads follow. */
  const saved = (list: RequestTypeSettingView[]) => {
    queryClient.setQueryData(['requests', tenant, 'types'], list);
    void queryClient.invalidateQueries({ queryKey: ['requests', tenant] });
  };

  const toggle = async (setting: RequestTypeSettingView): Promise<void> => {
    if (!token || toggleInFlight.current) return;
    toggleInFlight.current = true;
    setToggling(setting.requestType);
    const name = labels.requestType[setting.requestType];
    try {
      saved(
        await updateRequestType(tenant, token, {
          type: setting.requestType,
          enabled: !setting.enabled,
          feeAmount: setting.feeAmount,
        }),
      );
      toast.success(setting.enabled ? t('stopped', { name }) : t('restarted', { name }));
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6).
      toast.error(caught instanceof Error && caught.message ? caught.message : t('saveError'));
    } finally {
      toggleInFlight.current = false;
      setToggling(null);
    }
  };

  const tableLabels = useTableLabels({ empty: t('empty'), loadError: t('loadError') });

  const columns = useMemo<ColumnDef<RequestTypeSettingView>[]>(
    () => [
      {
        id: 'type',
        header: t('columns.type'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className={row.original.enabled ? 'min-w-0 space-y-0.5' : 'min-w-0 space-y-0.5 text-muted-foreground'}>
            <p className="font-medium">{labels.requestType[row.original.requestType]}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.needsProperty ? t('needsProperty') : t('propertyOptional')}
            </p>
          </div>
        ),
      },
      {
        id: 'fee',
        header: t('columns.fee'),
        cell: ({ row }) =>
          row.original.feeAmount > 0 ? (
            <Money amount={row.original.feeAmount} locale={locale} exact className="text-sm" />
          ) : (
            <CellTag tone="muted">{t('free')}</CellTag>
          ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) =>
          // The word carries the state; the colour only repeats it (COL-3).
          row.original.enabled ? (
            <CellTag tone="success">{t('offered')}</CellTag>
          ) : (
            <CellTag tone="muted">{t('stoppedLabel')}</CellTag>
          ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              cell: ({ row }: { row: { original: RequestTypeSettingView } }) => (
                <div className="flex items-center justify-end gap-1 max-sm:w-full">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(row.original.requestType)}>
                    <Pencil className="size-4" aria-hidden />
                    {t('editFee')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    // Not while its fee is open: the save sends the switch too, and the two would race.
                    disabled={toggling === row.original.requestType || editing === row.original.requestType}
                    onClick={() => void toggle(row.original)}
                  >
                    {row.original.enabled ? (
                      <CirclePause className="size-4" aria-hidden />
                    ) : (
                      <CirclePlay className="size-4" aria-hidden />
                    )}
                    {row.original.enabled ? t('stop') : t('restart')}
                  </Button>
                </div>
              ),
            } satisfies ColumnDef<RequestTypeSettingView>,
          ]
        : []),
    ],
    // `toggle` closes over the token and the in-flight ref; the row state it reads is `toggling`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canManage, toggling, editing, token, locale],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/requests`} label={t('back')} />
      <PageHeader icon={Tags} title={t('title')} />

      {canManage && edited && token ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <h2>{t('editTitle', { name: labels.requestType[edited.requestType] })}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Keyed by the row, so switching rows starts the editor from that row's fee. */}
            <FeeEditor
              key={edited.requestType}
              tenant={tenant}
              token={token}
              locale={locale}
              setting={edited}
              onCancel={() => setEditing(null)}
              onSaved={(list) => {
                setEditing(null);
                saved(list);
                toast.success(t('saved', { name: labels.requestType[edited.requestType] }));
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */}
      <DataTable
        columns={columns}
        data={types}
        labels={tableLabels}
        getRowId={(setting) => setting.requestType}
        searchable={false}
        sortable={false}
        paginated={false}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
      />

      <p className="text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}

/** The fee of one type, in whole pounds; 0 is free. */
function FeeEditor({
  tenant,
  token,
  locale,
  setting,
  onCancel,
  onSaved,
}: {
  tenant: string;
  token: string;
  locale: string;
  setting: RequestTypeSettingView;
  onCancel: () => void;
  onSaved: (list: RequestTypeSettingView[]) => void;
}): React.JSX.Element {
  const t = useTranslations('requests.types');
  const [fee, setFee] = useState(() => (setting.feeAmount > 0 ? formatTypedAmount(String(setting.feeAmount), 0) : ''));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    const parsed = updateRequestTypeSettingSchema.safeParse({ enabled: setting.enabled, feeAmount: parseAmount(fee) });
    if (!parsed.success) {
      setError(t('feeInvalid'));
      document.getElementById('request-type-fee')?.focus();
      return;
    }
    setError(null);
    inFlight.current = true;
    setSaving(true);
    try {
      onSaved(await updateRequestType(tenant, token, { type: setting.requestType, ...parsed.data }));
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof Error && caught.message ? caught.message : t('saveError'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <form noValidate onSubmit={save} className="flex flex-wrap items-end gap-3">
      <Field htmlFor="request-type-fee" label={t('fee')} error={error ?? undefined} className="w-full sm:w-64">
        <CurrencyInput
          id="request-type-fee"
          unit={currencyUnit('LBP', locale)}
          value={fee}
          placeholder="0"
          invalid={Boolean(error)}
          onChange={(raw) => setFee(formatTypedAmount(raw, 0))}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
      </div>
      <p className="w-full text-xs text-muted-foreground">{t('feeHint')}</p>
    </form>
  );
}
