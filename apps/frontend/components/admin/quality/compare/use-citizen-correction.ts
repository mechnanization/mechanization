'use client';

import { useRef, useState } from 'react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenForm,
  logApiError,
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
  /** A correction landed: what is on screen, and the queue behind it, are stale. */
  onSaved: () => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();
  // `ConfirmDialog` disables its button from state, set asynchronously (SUBMIT-04): a double-click
  // can reach `save` twice. Checked and set first, released when the write settles.
  const savingRef = useRef(false);

  /** The editable copy of each side, fetched only when somebody starts editing. */
  const [forms, setForms] = useState<Record<string, CitizenFormData>>({});
  const [loadingForm, setLoadingForm] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ side: 0 | 1; row: EditableRow } | null>(null);
  const [draft, setDraft] = useState<Partial<Record<CitizenEditableField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingEdit | null>(null);

  const cancelEdit = () => {
    setEditing(null);
    setDraft({});
    setProblem(null);
  };

  const startEdit = async (side: 0 | 1, citizenId: string, target: EditableRow) => {
    if (!token) return;
    setProblem(null);
    let form = forms[citizenId];
    if (!form) {
      setLoadingForm(citizenId);
      try {
        form = await getCitizenForm(tenant, token, citizenId);
        setForms((current) => ({ ...current, [citizenId]: form! }));
      } catch (caught) {
        logApiError(caught);
        toast.error(
          caught instanceof ApiRequestError
            ? caught.message
            : en
              ? 'Could not open this record for editing.'
              : 'تعذّر فتح هذا السجل للتعديل.',
        );
        return;
      } finally {
        setLoadingForm(null);
      }
    }
    const section = (field: CitizenEditableField) =>
      field === 'phone' ? form!.contact : form!.personal;
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
        setProblem(`${labels.citizenField[field] ?? field}: ${checked.message}`);
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
        target === 'name'
          ? en
            ? 'Full name'
            : 'الاسم الكامل'
          : (labels.citizenField[target] ?? target),
      before,
      after,
      values,
    });
  };

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await applySave();
    } finally {
      savingRef.current = false;
    }
  };

  const applySave = async () => {
    if (!pending || !token) return;
    const form = forms[pending.citizenId];
    if (!form) return;

    await updateCitizen(tenant, token, pending.citizenId, {
      ...citizenFieldPatch(form, pending.values),
      /*
        A correction made by comparing two records side by side — which may be
        an identity number (`highImpactChanges`), so the save says so on the
        audit row rather than being refused for want of a reason.
      */
      changeReason: en
        ? `Corrected while comparing two records in quality review: ${pending.label}`
        : `تصحيح عند مقارنة سجلَّين في مراجعة الجودة: ${pending.label}`,
    });

    toast.success(en ? 'The record was corrected.' : 'صُحِّح السجل.');
    /*
      The saved file's version is now stale in `forms`, and so is every value on
      it. Dropped rather than patched: the next edit re-reads it, which is also
      what makes the version check meaningful instead of a token carried
      forward.
    */
    setForms((current) => {
      const next = { ...current };
      delete next[pending.citizenId];
      return next;
    });
    setPending(null);
    cancelEdit();
    onSaved();
  };

  return { forms, loadingForm, editing, draft, setDraft, problem, pending, setPending, cancelEdit, startEdit, requestSave, save };
}

export type CitizenCorrection = ReturnType<typeof useCitizenCorrection>;
