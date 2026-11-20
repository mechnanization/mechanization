'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, Power, Shapes } from 'lucide-react';
import { getLabels, type BuildingTypeView } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, updateBuildingType } from '@/lib/api-client';
import { useBuildingTypes } from '@/lib/building-types';
import { BUILDING_TYPE_ADMIN_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { BuildingTypeDialog } from '@/components/admin/building-types/building-type-dialog';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';

/**
 * «أنواع المباني» — the municipality's building types (migration 0106; the
 * user's request of 2026-11-16): the system types, one per structure, then the
 * ones it added (مدرسة, مستوصف, مبنى بلدي, …), each with the structure whose
 * behaviour it takes, what its units start as, and how many buildings have it.
 *
 * Read by every staff role (`GET building-types`); the wizard, the editor, the
 * map and the reports read the same list. The manager adds, edits, switches
 * off and on (`BUILDING_TYPE_ADMIN_ROLES`); a type is never deleted, and one
 * switched off stays on the buildings that have it. A building's type changes
 * no fee: to exempt a public school, exempt its units.
 */
export default function BuildingTypesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('buildingTypes');
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canEdit = user ? hasRole(BUILDING_TYPE_ADMIN_ROLES, user.role) : false;

  const query = useBuildingTypes(tenant, base, token, { includeInactive: true, errorMessage: t('loadError') });
  const types = useMemo(() => query.data ?? [], [query.data]);

  /** The dialog: undefined closed, null adding, a type editing it. */
  const [editing, setEditing] = useState<BuildingTypeView | null | undefined>(undefined);
  const [toggling, setToggling] = useState<BuildingTypeView | null>(null);
  const inFlight = useRef(false);

  /** «إيقاف» / «إعادة تفعيل»: offered on new buildings or not; kept on the buildings that have it. */
  const toggle = async (): Promise<void> => {
    if (!token || !toggling || inFlight.current) return;
    inFlight.current = true;
    try {
      await updateBuildingType(tenant, token, toggling.id, { isActive: !toggling.isActive });
      toast.success(t(toggling.isActive ? 'deactivated' : 'activated', { name: toggling.nameAr }));
      setToggling(null);
      await queryClient.invalidateQueries({ queryKey: ['building-types', tenant] });
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current = false;
    }
  };

  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<BuildingTypeView>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{row.original.nameAr}</p>
            {row.original.nameEn ? (
              <p className="text-xs text-muted-foreground" dir="ltr">
                {row.original.nameEn}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'structure',
        header: t('columns.structure'),
        cell: ({ row }) => <CellTag>{labels.structureType[row.original.structureType]}</CellTag>,
      },
      {
        id: 'unit',
        header: t('columns.defaultUnitType'),
        meta: { mobile: 'hide' },
        cell: ({ row }) => <CellTag tone="muted">{labels.unitType[row.original.defaultUnitType]}</CellTag>,
      },
      {
        id: 'kind',
        header: t('columns.kind'),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {/* The word carries the state; the colour only repeats it (COL-3). */}
            <Badge variant={row.original.isSystem ? 'soft-info' : 'soft-default'}>
              {row.original.isSystem ? t('system') : t('custom')}
            </Badge>
            {row.original.isActive ? null : <Badge variant="soft-muted">{t('inactive')}</Badge>}
          </div>
        ),
      },
      {
        id: 'count',
        header: t('columns.buildings'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <span className="tabular-nums">{row.original.buildingCount.toLocaleString('en-US')}</span>,
      },
      ...(canEdit
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              cell: ({ row }: { row: { original: BuildingTypeView } }) => (
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setEditing(row.original)}>
                    <Pencil className="size-4" aria-hidden />
                    {t('edit')}
                  </Button>
                  <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setToggling(row.original)}>
                    <Power className="size-4" aria-hidden />
                    {row.original.isActive ? t('deactivate') : t('activate')}
                  </Button>
                </div>
              ),
            } satisfies ColumnDef<BuildingTypeView>,
          ]
        : []),
    ],
    [t, labels, canEdit],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/buildings`} label={t('back')} />

      <PageHeader
        icon={Shapes}
        title={t('title')}
        actions={
          canEdit ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="size-4" aria-hidden />
              {t('add')}
            </Button>
          ) : null
        }
      />

      <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>

      {/* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */}
      <DataTable
        columns={columns}
        data={types}
        labels={tableLabels}
        getRowId={(type) => type.id}
        searchable={false}
        sortable={false}
        paginated={false}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
      />

      {editing !== undefined && token ? (
        <BuildingTypeDialog tenant={tenant} token={token} locale={locale} editing={editing} onClose={() => setEditing(undefined)} />
      ) : null}

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(next) => {
          if (!next) setToggling(null);
        }}
        destructive={false}
        title={t(toggling?.isActive ? 'deactivateTitle' : 'activateTitle', { name: toggling?.nameAr ?? '' })}
        description={t(toggling?.isActive ? 'deactivateBody' : 'activateBody')}
        confirmLabel={toggling?.isActive ? t('deactivate') : t('activate')}
        cancelLabel={t('cancel')}
        onConfirm={toggle}
      />
    </div>
  );
}
