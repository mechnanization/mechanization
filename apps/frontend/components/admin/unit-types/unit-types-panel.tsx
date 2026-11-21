'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, Power } from 'lucide-react';
import { unitTypeName, type UnitTypeView } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, updateUnitType } from '@/lib/api-client';
import { UNIT_TYPE_ADMIN_ROLES, hasRole } from '@/lib/staff-roles';
import { useTableLabels } from '@/lib/use-table-labels';
import { useUnitTypes } from '@/lib/unit-types';
import { UnitTypeDialog } from '@/components/admin/unit-types/unit-type-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { useToast } from '@/components/ui/toast';

/**
 * «أنواع الوحدات» — the municipality's unit types (migration 0109; the user's
 * request of 2026-11-21) as **one flat list**: شقة, محل, مكتب … and what the
 * manager added (مدرسة, شركة كهرباء, شركة مياه, …), each with how many units
 * have it. Nothing on screen says which came with the system or what a type
 * bills as; the server bills a new one as `DEFAULT_UNIT_TYPE_BASE`.
 *
 * The second tab of `buildings/types`. Read by every staff role
 * (`GET unit-types`); the matrix and the building editor read the same list.
 * The manager adds, edits, switches off and on (`UNIT_TYPE_ADMIN_ROLES`); a type
 * is never deleted, and one switched off stays on the units that have it.
 */
export function UnitTypesPanel({
  tenant,
  base,
  locale,
  token,
  role,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  role: string | undefined;
}) {
  const t = useTranslations('unitTypes');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canEdit = role ? hasRole(UNIT_TYPE_ADMIN_ROLES, role) : false;

  const query = useUnitTypes(tenant, base, token, { includeInactive: true, errorMessage: t('loadError') });
  const types = useMemo(() => query.data ?? [], [query.data]);

  /** The dialog: undefined closed, null adding, a type editing it. */
  const [editing, setEditing] = useState<UnitTypeView | null | undefined>(undefined);
  const [toggling, setToggling] = useState<UnitTypeView | null>(null);
  const inFlight = useRef(false);

  /** «إيقاف» / «إعادة تفعيل»: offered on new units or not; kept on the units that have it. */
  const toggle = async (): Promise<void> => {
    if (!token || !toggling || inFlight.current) return;
    inFlight.current = true;
    try {
      await updateUnitType(tenant, token, toggling.id, { isActive: !toggling.isActive });
      toast.success(t(toggling.isActive ? 'deactivated' : 'activated', { name: unitTypeName(toggling, locale) }));
      setToggling(null);
      await queryClient.invalidateQueries({ queryKey: ['unit-types', tenant] });
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current = false;
    }
  };

  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<UnitTypeView>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{row.original.nameAr}</p>
              {/* The word carries the state; the colour only repeats it (COL-3). */}
              {row.original.isActive ? null : <Badge variant="soft-muted">{t('inactive')}</Badge>}
            </div>
            {row.original.nameEn ? (
              <p className="text-xs text-muted-foreground" dir="ltr">
                {row.original.nameEn}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'count',
        header: t('columns.units'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <span className="tabular-nums">{row.original.unitCount.toLocaleString('en-US')}</span>,
      },
      ...(canEdit
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              cell: ({ row }: { row: { original: UnitTypeView } }) => (
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
            } satisfies ColumnDef<UnitTypeView>,
          ]
        : []),
    ],
    [t, canEdit],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>
        {canEdit ? (
          <Button onClick={() => setEditing(null)}>
            <Plus className="size-4" aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </div>

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
        <UnitTypeDialog tenant={tenant} token={token} editing={editing} onClose={() => setEditing(undefined)} />
      ) : null}

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(next) => {
          if (!next) setToggling(null);
        }}
        destructive={false}
        title={t(toggling?.isActive ? 'deactivateTitle' : 'activateTitle', { name: toggling ? unitTypeName(toggling, locale) : '' })}
        description={t(toggling?.isActive ? 'deactivateBody' : 'activateBody')}
        confirmLabel={toggling?.isActive ? t('deactivate') : t('activate')}
        cancelLabel={t('cancel')}
        onConfirm={toggle}
      />
    </div>
  );
}
