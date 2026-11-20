'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  BUILDING_TYPE_NAME_MAX,
  createBuildingTypeSchema,
  getLabels,
  isStructuralUnitType,
  STRUCTURE_TYPE,
  STRUCTURE_TYPE_MAP,
  UNIT_TYPE,
  updateBuildingTypeSchema,
  type BuildingTypeView,
  type StructureType,
  type UnitType,
} from '@mechanization/shared-schemas';
import { createBuildingType, logApiError, updateBuildingType } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** The unit types a building type may start its units as: premises, never a structural floor. */
const PREMISES = UNIT_TYPE.filter((type) => !isStructuralUnitType(type));

/**
 * Adds a building type, or edits one (0106). The manager's; the server refuses
 * anyone else. A type's `structureType` is the behaviour it takes — what the
 * census counts it as, what its units start as by default — and is fixed on a
 * system type, and on a custom type once a building has it: the select is
 * offered only where the server would take it. Renaming changes the label only.
 */
export function BuildingTypeDialog({
  tenant,
  token,
  locale,
  editing,
  onClose,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** The type being edited, or null to add one. */
  editing: BuildingTypeView | null;
  onClose: () => void;
}) {
  const t = useTranslations('buildingTypes');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const [nameAr, setNameAr] = useState(editing?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(editing?.nameEn ?? '');
  const [structureType, setStructureType] = useState<StructureType>(editing?.structureType ?? 'PUBLIC_INSTITUTION');
  const [defaultUnitType, setDefaultUnitType] = useState<UnitType>(editing?.defaultUnitType ?? 'OFFICE');
  const [sortOrder, setSortOrder] = useState(String(editing?.sortOrder ?? 100));
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const structureFixed = Boolean(editing && (editing.isSystem || editing.buildingCount > 0));

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;
    const body = {
      nameAr,
      nameEn: editing ? nameEn.trim() || null : nameEn.trim() || undefined,
      structureType,
      defaultUnitType,
      sortOrder: Number(sortOrder) || 0,
    };
    const parsed = editing
      ? updateBuildingTypeSchema.safeParse({ ...body, structureType: structureFixed ? undefined : structureType })
      : createBuildingTypeSchema.safeParse(body);
    if (!parsed.success) {
      setNameError(t('nameRequired'));
      document.getElementById('building-type-name')?.focus();
      return;
    }
    setNameError(null);
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) await updateBuildingType(tenant, token, editing.id, parsed.data as never);
      else await createBuildingType(tenant, token, parsed.data as never);
      await queryClient.invalidateQueries({ queryKey: ['building-types', tenant] });
      onClose();
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6).
      setFormError(caught instanceof Error ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-w-md" closeLabel={t('close')}>
        <DialogHeader>
          <DialogTitle>{editing ? t('editTitle') : t('addTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>

        <form noValidate className="space-y-4" onSubmit={submit}>
          <Field htmlFor="building-type-name" label={t('nameAr')} error={nameError ?? undefined} required>
            <Input
              id="building-type-name"
              value={nameAr}
              maxLength={BUILDING_TYPE_NAME_MAX}
              placeholder={t('nameArPlaceholder')}
              invalid={Boolean(nameError)}
              onChange={(event) => {
                setNameAr(event.target.value);
                setNameError(null);
              }}
            />
          </Field>
          <Field htmlFor="building-type-name-en" label={t('nameEn')}>
            <Input
              id="building-type-name-en"
              dir="ltr"
              value={nameEn}
              maxLength={BUILDING_TYPE_NAME_MAX}
              placeholder={t('nameEnPlaceholder')}
              onChange={(event) => setNameEn(event.target.value)}
            />
          </Field>
          <Field htmlFor="building-type-structure" label={t('structure')} required>
            <Select
              value={structureType}
              disabled={structureFixed}
              onValueChange={(value) => {
                const next = value as StructureType;
                setStructureType(next);
                // A new type starts its units as its structure does, until the manager says otherwise.
                if (!editing) setDefaultUnitType(STRUCTURE_TYPE_MAP[next].defaultUnitType);
              }}
            >
              <SelectTrigger id="building-type-structure">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRUCTURE_TYPE.map((value) => (
                  <SelectItem key={value} value={value}>
                    {labels.structureType[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {structureFixed ? (
            <p className="text-xs text-muted-foreground">
              {editing?.isSystem ? t('structureFixedSystem') : t('structureFixedUsed', { count: editing?.buildingCount ?? 0 })}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="building-type-unit" label={t('defaultUnitType')} required>
              <Select value={defaultUnitType} onValueChange={(value) => setDefaultUnitType(value as UnitType)}>
                <SelectTrigger id="building-type-unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PREMISES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {labels.unitType[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field htmlFor="building-type-order" label={t('sortOrder')}>
              <Input
                id="building-type-order"
                inputMode="numeric"
                dir="ltr"
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value.replace(/[^\d]/g, ''))}
              />
            </Field>
          </div>

          <Alert variant="info">{t('noFee')}</Alert>

          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">
              {busy ? t('saving') : editing ? t('save') : t('add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
