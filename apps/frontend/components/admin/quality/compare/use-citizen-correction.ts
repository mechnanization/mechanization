'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenForm,
  logApiError,
  staleEditOf,
  updateCitizen,
  type CitizenFormData,
  type CitizenProfile,
} from '@/lib/api-client';
import { citizenFieldPatch, isEditableOn, type CitizenEditableField } from '@/lib/citizen-field-edit';
import { useToast } from '@/components/ui/toast';
import { NAME_FIELDS, ROW_FIELDS, validateField, type EditableRow } from './citizen-rows';

/** What is being changed, while the confirmation is on screen. */
export interface PendingEdit {
  side: 0 | 1;
  citizenId: string;
  row: EditableRow;
  label: string;
  before: string;
  after: string;
  values: Partial<Record<CitizenEditableField, string>>;
}

/**
 * Correcting a name, a mother's name or a phone from beside the other record:
 * the editable copy of a file, what is typed, the check made before asking, the
 * question, and the one write, which sends the file back as it was read with its
 * version.
 */
export function useCitizenCorrection({
  tenant,
  token,
  locale,
  onSaved,
}: {
  tenant: string;
  token: string | null;
  locale: string;
  /** This file changed on the server: what is on screen, and the queue behind it, are stale. */
  onSaved: (citizenId: string) => void;
}) {
  const t = useTranslations('qualityCompare.edit');
  const tRows = useTranslations('qualityCompare.rows');
  const tErrors = useTranslations('qualityCompare.errors');
  const labels = getLabels(locale);
  const toast = useToast();
  /*
    The save on the wire. `ConfirmDialog` disables its button from state, set asynchronously
    (SUBMIT-04), so a double-click can reach `save` twice. The second press is handed the same
    answer: returning at once told the dialog it had succeeded, and it closed over a write that
    could still be refused, with nowhere left to say so.
  */
  const saving = useRef<Promise<void> | null>(null);
  /** Counts what was asked of the editor: a file that answers after a later ask is dropped. */
  const asked = useRef(0);

  /** The editable copy of each side, read when somebody starts editing, every time. */
  const [forms, setForms] = useState<Record<string, CitizenFormData>>({});
  const [loadingForm, setLoadingForm] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ side: 0 | 1; row: EditableRow } | null>(null);
  const [draft, setDraft] = useState<Partial<Record<CitizenEditableField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingEdit | null>(null);

  const cancelEdit = () => {
    asked.current += 1;
    setLoadingForm(null);
    setEditing(null);
    setDraft({});
    setProblem(null);
  };

  const startEdit = async (side: 0 | 1, citizenId: string, target: EditableRow) => {
    if (!token) return;
    // One editor at a time: the one open, or still opening, gives way to this one.
    cancelEdit();
    const request = asked.current;
    setLoadingForm(citizenId);
    let form: CitizenFormData;
    try {
      /*
        Read on every «Edit», never kept from the last one: the save carries this copy's version, so a
        copy read before somebody else's save would be refused, and refused again on every retry.
      */
      form = await getCitizenForm(tenant, token, citizenId);
    } catch (caught) {
      logApiError(caught);
      if (request !== asked.current) return;
      setLoadingForm(null);
      toast.error(caught instanceof ApiRequestError ? caught.message : t('openFailed'));
      return;
    }
    if (request !== asked.current) return;
    setLoadingForm(null);
    setForms((current) => ({ ...current, [citizenId]: form }));
    const section = (field: CitizenEditableField) => (field === 'phone' ? form.contact : form.personal);
    setDraft(
      Object.fromEntries(
        ROW_FIELDS[target].map((field) => [field, String(section(field)[field] ?? '')]),
      ),
    );
    setEditing({ side, row: target });
  };

  /** Validates the draft and, if it holds, raises the confirmation. */
  const requestSave = (side: 0 | 1, person: CitizenProfile, target: EditableRow) => {
    const form = forms[person.id];
    if (!form) return;

    const values: Partial<Record<CitizenEditableField, string>> = {};
    for (const field of ROW_FIELDS[target]) {
      if (!isEditableOn(form, field)) continue;
      const checked = validateField(field, draft[field] ?? '', form);
      if (!checked.ok) {
        setProblem(`${labels.citizenField[field] ?? field}: ${tErrors(checked.problem)}`);
        return;
      }
      values[field] = checked.value;
    }

    const before =
      target === 'name'
        ? person.fullName
        : target === 'motherName'
          ? (person.motherName ?? '—')
          : (person.phone ?? '—');
    const after =
      target === 'name'
        ? NAME_FIELDS.map((field) => values[field] ?? '')
            .filter(Boolean)
            .join(' ')
        : (values[target === 'motherName' ? 'motherName' : 'phone'] ?? '');

    if (before === after) {
      cancelEdit();
      return;
    }

    setProblem(null);
    setPending({
      side,
      citizenId: person.id,
      row: target,
      label:
        target === 'name' ? tRows('fullName') : (labels.citizenField[target] ?? target),
      before,
      after,
      values,
    });
  };

  const save = (): Promise<void> => {
    saving.current ??= applySave().finally(() => {
      saving.current = null;
    });
    return saving.current;
  };

  const applySave = async () => {
    if (!pending || !token) return;
    const form = forms[pending.citizenId];
    if (!form) return;

    try {
      await updateCitizen(tenant, token, pending.citizenId, {
        ...citizenFieldPatch(form, pending.values),
        /*
          A correction made by comparing two records side by side — which may be
          an identity number (`highImpactChanges`), so the save says so on the
          audit row rather than being refused for want of a reason.
        */
        changeReason: t('reason', { field: pending.label }),
      });
    } catch (caught) {
      const stale = staleEditOf(caught);
      const merged = caught instanceof ApiRequestError && caught.code === 'CITIZEN_FILE_STALE_MERGED';
      // Any other refusal is the question's to show, and to try again.
      if (!stale && !merged) throw caught;
      /*
        Somebody changed the file since it was opened. This copy's version is spent, so saving it
        again could only be refused again: the question closes, the two files are read again, and the
        officer decides on what is there now. (The server's own sentence offers «save to replace»,
        which this screen does not do.)
      */
      logApiError(caught);
      toast.warning(stale?.lastEditedBy ? t('changedBy', { name: stale.lastEditedBy }) : t('changed'));
      close(pending.citizenId);
      return;
    }

    toast.success(t('saved'));
    close(pending.citizenId);
  };

  /*
    After a save, or a file found changed: the question and the editor close, and the screen reads what is
    there now. The copy just used is never saved again: the next «Edit» reads the file afresh.
  */
  const close = (citizenId: string) => {
    setPending(null);
    cancelEdit();
    onSaved(citizenId);
  };

  return { forms, loadingForm, editing, draft, setDraft, problem, pending, setPending, cancelEdit, startEdit, requestSave, save };
}

export type CitizenCorrection = ReturnType<typeof useCitizenCorrection>;
