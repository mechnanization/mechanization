'use client';

import { useTranslations } from 'next-intl';
import { Loader2, Pencil } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { CitizenProfile } from '@/lib/api-client';
import { isEditableOn } from '@/lib/citizen-field-edit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ROW_FIELDS, type EditableRow } from './citizen-rows';
import type { CitizenCorrection } from './use-citizen-correction';

/** The edit control, or the inputs, for one editable row on one side. */
export function EditCell({
  side,
  target,
  person,
  correction,
  canEdit,
  locale,
}: {
  side: 0 | 1;
  target: EditableRow;
  person: CitizenProfile;
  correction: CitizenCorrection;
  canEdit: boolean;
  locale: string;
}): React.ReactNode {
  const t = useTranslations('qualityCompare.edit');
  const labels = getLabels(locale);
  const tNoPhone = useTranslations('citizenForm.noPhone');
  const tKind = useTranslations('citizenKind');
  const { forms, loadingForm, editing, draft, setDraft, problem, cancelEdit, startEdit, requestSave } = correction;
  const form = forms[person.id];
  const open = editing?.side === side && editing.row === target;

  if (!canEdit) return null;

  /*
    A file that is not a household's («غير مقيم في البلدة», «تركة», «جهة أو
    وقف») is never asked for اسم الأم — its form does not have the field. Said here rather than left as a missing button: one side of
    the comparison offering «تعديل» where the other does not reads as a fault
    until you know why.
  */
  if (target === 'motherName' && person.residence && person.residence !== 'RESIDENT') {
    return (
      <span className="mt-1 block text-xs text-muted-foreground">
        {tKind('motherNotAsked')}
      </span>
    );
  }

  /*
    «لا يملك رقم هاتف» is a finished answer, and the flag decides over the
    field: a number typed here would be dropped on save while the screen said
    the record was corrected (`isEditableOn`). Said instead of offered, for the
    same reason as above — and it says where the change is made.
  */
  if (target === 'phone' && person.hasNoPhone) {
    return (
      <span className="mt-1 block text-xs text-muted-foreground">{tNoPhone('compareNote')}</span>
    );
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-muted-foreground"
        disabled={loadingForm === person.id}
        onClick={() => void startEdit(side, person.id, target)}
      >
        {loadingForm === person.id ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <Pencil className="size-3" aria-hidden />
        )}
        {t('edit')}
      </Button>
    );
  }

  const fields = ROW_FIELDS[target].filter((field) => !form || isEditableOn(form, field));

  return (
    <div className="mt-1.5 space-y-2">
      {fields.map((field) => (
        <div key={field} className="space-y-1">
          <label htmlFor={`edit-${side}-${field}`} className="text-xs text-muted-foreground">
            {labels.citizenField[field] ?? field}
          </label>
          <Input
            id={`edit-${side}-${field}`}
            value={draft[field] ?? ''}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [field]: event.target.value }))
            }
            dir={field === 'phone' ? 'ltr' : undefined}
            maxLength={60}
            className="h-9"
          />
        </div>
      ))}
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" className="h-8" onClick={() => requestSave(side, person, target)}>
          {t('save')}
        </Button>
        <Button variant="ghost" size="sm" className="h-8" onClick={cancelEdit}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
