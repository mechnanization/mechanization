'use client';

import type { CitizenMergeResult, CitizenResidence } from '@mechanization/shared-schemas';
import { withFlagsApplied } from '@/lib/citizen-form-state';
import type { CitizenFormValues } from '@/lib/citizen-form-values';
import { MergeCitizensDialog } from '../merge-citizens-dialog';
import { ParcelRosterDialog } from '../parcel-roster-dialog';
import { QuickSaveDialog } from '../quick-save-dialog';
import { ResidenceChangeDialog } from '../residence-change-dialog';
import { UnverifiedFieldsDialog } from '../unverified-fields-dialog';
import type { useResidenceChange } from './use-residence-change';

type Residence = ReturnType<typeof useResidenceChange>;

/**
 * The form's five dialogs, in the order they had (GOD-22, phase 2c): the quick
 * save, the parcel's roster, «خانات غير مؤكَّدة», «دمج» and «تغيير الإقامة».
 *
 * Moved out of `CitizenForm` with their JSX unchanged; what they read from the
 * form's scope is a prop under the same name. They are closed on first paint, so
 * the form's render test cannot see them: they are read in review and tried on
 * staging. The two the residence guide used to carry inline are `correctResidence`
 * and `applyMove` of `useResidenceChange`.
 */
export function CitizenFormDialogs({
  tenant,
  token,
  citizenId,
  locale,
  values,
  setValues,
  submitting,
  error,
  quickSaveOpen,
  setQuickSaveOpen,
  gapCount,
  handleSubmit,
  rosterParcel,
  setRosterParcel,
  unverifiedDialogOpen,
  setUnverifiedDialogOpen,
  mergeWith,
  setMergeWith,
  onMerged,
  residenceGuide,
  setResidenceGuide,
  correctResidence,
  applyMove,
  removeProperty,
  removeEndedRows,
  onDeactivated,
}: {
  tenant: string;
  token?: string | null;
  citizenId?: string;
  locale: string;
  values: CitizenFormValues;
  setValues: React.Dispatch<React.SetStateAction<CitizenFormValues>>;
  submitting: boolean;
  error: string | null;
  quickSaveOpen: boolean;
  setQuickSaveOpen: (open: boolean) => void;
  gapCount: number;
  handleSubmit: (withBlanketReason?: string) => void;
  rosterParcel: string | null;
  setRosterParcel: (parcel: string | null) => void;
  unverifiedDialogOpen: boolean;
  setUnverifiedDialogOpen: (open: boolean) => void;
  mergeWith: string | null;
  setMergeWith: (id: string | null) => void;
  onMerged?: (result: CitizenMergeResult) => void;
  residenceGuide: CitizenResidence | null;
  setResidenceGuide: Residence['setResidenceGuide'];
  correctResidence: Residence['correctResidence'];
  applyMove: Residence['applyMove'];
  removeProperty: (index: number) => void;
  removeEndedRows: (index: number, rowIds: readonly string[]) => void;
  onDeactivated?: () => void;
}): React.JSX.Element {
  return (
    <>
      <QuickSaveDialog
        open={quickSaveOpen}
        onOpenChange={setQuickSaveOpen}
        gapCount={gapCount}
        submitting={submitting}
        error={error}
        onConfirm={(reason) => handleSubmit(reason)}
        locale={locale}
      />

      {token && rosterParcel ? (
        <ParcelRosterDialog
          open
          onOpenChange={(next) => setRosterParcel(next ? rosterParcel : null)}
          tenant={tenant}
          token={token}
          propertyNumber={rosterParcel}
          locale={locale}
        />
      ) : null}

      <UnverifiedFieldsDialog
        open={unverifiedDialogOpen}
        onOpenChange={setUnverifiedDialogOpen}
        values={values}
        onSaveFlags={(newFlags) => setValues((current) => withFlagsApplied(current, newFlags))}
        locale={locale}
      />
      {mergeWith && citizenId && token && onMerged ? (
        <MergeCitizensDialog
          open
          onOpenChange={(next) => (next ? undefined : setMergeWith(null))}
          tenant={tenant}
          token={token}
          locale={locale}
          firstId={citizenId}
          secondId={mergeWith}
          onMerged={(result) => {
            setMergeWith(null);
            onMerged(result);
          }}
        />
      ) : null}
      {residenceGuide && citizenId ? (
        <ResidenceChangeDialog
          open
          to={residenceGuide}
          values={values}
          tenant={tenant}
          token={token}
          citizenId={citizenId}
          locale={locale}
          onCancel={() => setResidenceGuide(null)}
          onCorrect={() => correctResidence(residenceGuide)}
          onApply={(answers) => applyMove(residenceGuide, answers)}
          onTenancyEnded={(index, result, cardEnded) =>
            cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
          }
          onRemoveUnsaved={(index) => removeProperty(index)}
          onDeactivated={() => {
            setResidenceGuide(null);
            onDeactivated?.();
          }}
        />
      ) : null}
    </>
  );
}
