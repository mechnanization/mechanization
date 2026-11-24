import { useCallback, useRef, useState } from 'react';
import { isNonPersonRecord, type CitizenResidence } from '@mechanization/shared-schemas';
import { withResidence } from '@/lib/citizen-seed';
import { applyResidenceMove, planResidenceMove } from '@/lib/residence-move';
import type { CitizenFormValues } from '@/lib/citizen-form-values';

/** The answers «تغيير الإقامة» collects, as `applyResidenceMove` takes them. */
type MoveAnswers = Parameters<typeof applyResidenceMove>[2];

/**
 * Switching نوع الملف, and «تغيير الإقامة» on a saved file (GOD-22, phase 2c).
 *
 * Moved out of `CitizenForm` with its text unchanged. The two handlers the
 * guide dialog used to carry inline are named here (`correctResidence`,
 * `applyMove`), because `applyMove` is where the form as it stood is kept for
 * «تراجع» to restore (`beforeMove`). Each takes the guide's target as an
 * argument: the dialog is only drawn while there is one.
 */
export function useResidenceChange({
  values,
  setValues,
  mode,
  citizenId,
}: {
  values: CitizenFormValues;
  setValues: React.Dispatch<React.SetStateAction<CitizenFormValues>>;
  mode: 'create' | 'edit';
  citizenId?: string;
}) {
  /** Switching نوع الملف. See `withResidence`. */
  const setResidence = useCallback((residence: CitizenResidence) => {
    setValues((current) => withResidence(current, residence));
  }, [setValues]);

  /**
   * «تغيير الإقامة» on a saved file.
   *
   * Changing the answer on a saved file opens the guide rather than flipping
   * it: a real move has tenancies to end and homes to re-describe
   * (`planResidenceMove`), and the guide also offers the plain switch for a
   * residence recorded wrongly. A new filing just answers the question.
   *
   * Changing it back while a move is applied here undoes that move — the form
   * as it was the moment the move was applied. Tenancies the guide ended stay
   * ended: they were saved, on their day, as facts.
   */
  const [residenceGuide, setResidenceGuide] = useState<CitizenResidence | null>(null);
  const beforeMove = useRef<CitizenFormValues | null>(null);
  const chooseResidence = useCallback(
    (next: CitizenResidence) => {
      if (next === (values.residence ?? 'RESIDENT')) return;
      if (values.residenceMove) {
        const snapshot = beforeMove.current;
        beforeMove.current = null;
        setValues(snapshot ?? { ...withResidence(values, next), residenceMove: undefined });
        return;
      }
      /*
        The guide is for what happened to a person: a move into or out of the
        town, or a death (→ «تركة»). Anything else — a file that was always an
        institution, or an estate recorded by mistake — is a correction, and
        the form's own checks say what it leaves to settle.
      */
      const current = values.residence ?? 'RESIDENT';
      const guided =
        (current === 'RESIDENT' && next === 'NON_RESIDENT_OWNER') ||
        (current === 'NON_RESIDENT_OWNER' && next === 'RESIDENT') ||
        (!isNonPersonRecord(current) && next === 'ESTATE');
      if (mode === 'edit' && citizenId && guided) {
        setResidenceGuide(next);
        return;
      }
      setResidence(next);
    },
    [values, setValues, mode, citizenId, setResidence],
  );

  /** Undoes the move or death applied on this form — the form as it was before it. */
  const undoMove = useCallback(() => {
    const snapshot = beforeMove.current;
    beforeMove.current = null;
    if (snapshot) setValues(snapshot);
    else setValues((current) => ({ ...current, residenceMove: undefined }));
  }, [setValues]);

  /** «تصحيح» in the guide: the plain switch, and no move recorded. */
  const correctResidence = (to: CitizenResidence) => {
    setValues((current) => ({ ...withResidence(current, to), residenceMove: undefined }));
    setResidenceGuide(null);
  };

  /** «تطبيق» in the guide: the move planned for `to`, with the officer's answers; the form as it was is kept for `undoMove`. */
  const applyMove = (to: CitizenResidence, answers: MoveAnswers) => {
    beforeMove.current = values;
    setValues(applyResidenceMove(values, planResidenceMove(values, to), answers));
    setResidenceGuide(null);
  };

  return { residenceGuide, setResidenceGuide, chooseResidence, undoMove, correctResidence, applyMove };
}
