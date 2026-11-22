'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  UNIT_TYPE_NAME_MAX,
  createUnitTypeSchema,
  updateUnitTypeSchema,
  type UnitTypeView,
} from '@mechanization/shared-schemas';
import { createUnitType, logApiError, updateUnitType } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Adds a unit type, or renames one (0109). The manager's; the server refuses
 * anyone else. The form asks for the names and the place in the list, nothing
 * more: one flat list, no billing base on screen (the user's decision of
 * 2026-11-21). A new type is billed as `DEFAULT_UNIT_TYPE_BASE` by the server,
 * and an edit never sends a base, so renaming can never move what a type bills as.
 */
export function UnitTypeDialog({
  tenant,
  token,
  editing,
  onClose,
}: {
  tenant: string;
  token: string;
  /** The type being edited, or null to add one. */
  editing: UnitTypeView | null;
  onClose: () => void;
}) {
  const t = useTranslations('unitTypes');
  const queryClient = useQueryClient();
  const [nameAr, setNameAr] = useState(editing?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(editing?.nameEn ?? '');
  const [sortOrder, setSortOrder] = useState(String(editing?.sortOrder ?? 100));
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;
    const body = {
      nameAr,
      nameEn: editing ? nameEn.trim() || null : nameEn.trim() || undefined,
      sortOrder: Number(sortOrder) || 0,
    };
    const parsed = editing ? updateUnitTypeSchema.safeParse(body) : createUnitTypeSchema.safeParse(body);
    if (!parsed.success) {
      setNameError(t('nameRequired'));
      document.getElementById('unit-type-name')?.focus();
      return;
    }
    setNameError(null);
    setFormError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) await updateUnitType(tenant, token, editing.id, parsed.data as never);
      else await createUnitType(tenant, token, parsed.data as never);
      await queryClient.invalidateQueries({ queryKey: ['unit-types', tenant] });
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
          <Field htmlFor="unit-type-name" label={t('nameAr')} error={nameError ?? undefined} required>
            <Input
              id="unit-type-name"
              value={nameAr}
              maxLength={UNIT_TYPE_NAME_MAX}
              placeholder={t('nameArPlaceholder')}
              invalid={Boolean(nameError)}
              onChange={(event) => {
                setNameAr(event.target.value);
                setNameError(null);
              }}
            />
          </Field>
          <Field htmlFor="unit-type-name-en" label={t('nameEn')}>
            <Input
              id="unit-type-name-en"
              dir="ltr"
              value={nameEn}
              maxLength={UNIT_TYPE_NAME_MAX}
              placeholder={t('nameEnPlaceholder')}
              onChange={(event) => setNameEn(event.target.value)}
            />
          </Field>
          <Field htmlFor="unit-type-order" label={t('sortOrder')}>
            <Input
              id="unit-type-order"
              inputMode="numeric"
              dir="ltr"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value.replace(/[^\d]/g, ''))}
            />
          </Field>

          {editing ? null : <Alert variant="info">{t('noFee')}</Alert>}

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
