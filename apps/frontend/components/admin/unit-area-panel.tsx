'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { areaField, isStructuralUnitType } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * «مساحة الوحدة» under the selected unit — the census's own area, which billing
 * reads before any card's (`preferLinked`) and which a linked card shows locked.
 * This is the one place it is corrected, so it is shown to everyone and edited
 * by whoever may write the census. Saved on its own, like the levels.
 */
export function UnitAreaPanel({
  unit,
  busy,
  canEdit,
  onSave,
}: {
  unit: { id: string; unitType: string; unitArea: number | null };
  busy: boolean;
  canEdit: boolean;
  onSave: (unitArea: number) => void;
}) {
  const t = useTranslations('unitArea');
  const stored = unit.unitArea != null ? String(Number(unit.unitArea)) : '';
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue(stored);
    setError(null);
  }, [stored, unit.id]);

  // A طابق أعمدة or a طابق فارغ is drawn, never billed: it has no area to correct.
  if (isStructuralUnitType(unit.unitType)) return null;

  const save = () => {
    const parsed = areaField.safeParse(value.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('invalid'));
      return;
    }
    setError(null);
    onSave(parsed.data);
  };

  const id = `unit-area-${unit.id}`;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Field label={t('label')} htmlFor={id} error={error ?? undefined}>
        <Input
          id={id}
          inputMode="decimal"
          dir="ltr"
          className="tabular-nums"
          placeholder={t('unmeasured')}
          value={value}
          invalid={Boolean(error)}
          readOnly={!canEdit}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
      </Field>
      {canEdit && value.trim() !== stored ? (
        <Button size="sm" disabled={busy || value.trim() === ''} onClick={save}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}
