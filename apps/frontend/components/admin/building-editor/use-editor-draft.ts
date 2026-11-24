import { useEffect } from 'react';
import {
  clearBuildingDraft,
  editDraftFingerprint,
  loadBuildingDraft,
  saveBuildingDraft,
  type BuildingDraft,
} from '@/lib/building-draft';
import {
  type GridUnitDraft,
} from '../unit-grid-picker';

/**
 * The session draft: restored once on mount, written on every change.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useEditorDraft({
  restoredRef,
  tenant,
  buildingId,
  markDraftBase,
  setStep,
  setParcelNumber,
  pinParcelRef,
  setName,
  setPostedNumber,
  setZoneId,
  setIsPartitioned,
  setPartitionNumbers,
  setSharedParcels,
  setStructureType,
  setBuildingTypeId,
  setLifecycleStatus,
  setFloorsCount,
  setBasementsCount,
  setNotes,
  setPin,
  setGridSize,
  setGridUnits,
  setAcknowledgedDuplicates,
  setDuplicateReason,
  setNoPinReason,
  draftRestoredRef,
  step,
  parcelNumber,
  name,
  postedNumber,
  zoneId,
  isPartitioned,
  partitionNumbers,
  sharedParcels,
  structureType,
  buildingTypeId,
  lifecycleStatus,
  floorsCount,
  basementsCount,
  notes,
  pin,
  gridSize,
  gridUnits,
  acknowledgedDuplicates,
  duplicateReason,
  noPinReason,
  draftBase,
  pristineRef,
}: {
  restoredRef: React.MutableRefObject<boolean>;
  tenant: string;
  buildingId: string | undefined;
  markDraftBase: (updatedAt: string | null) => void;
  setStep: React.Dispatch<React.SetStateAction<0 | 1 | 2>>;
  setParcelNumber: React.Dispatch<React.SetStateAction<string>>;
  pinParcelRef: React.MutableRefObject<string | null>;
  setName: React.Dispatch<React.SetStateAction<string>>;
  setPostedNumber: React.Dispatch<React.SetStateAction<string>>;
  setZoneId: React.Dispatch<React.SetStateAction<string>>;
  setIsPartitioned: React.Dispatch<React.SetStateAction<boolean>>;
  setPartitionNumbers: React.Dispatch<React.SetStateAction<string[]>>;
  setSharedParcels: React.Dispatch<React.SetStateAction<string[]>>;
  setStructureType: React.Dispatch<React.SetStateAction<"INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION">>;
  setBuildingTypeId: React.Dispatch<React.SetStateAction<string>>;
  setLifecycleStatus: React.Dispatch<React.SetStateAction<"UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED">>;
  setFloorsCount: React.Dispatch<React.SetStateAction<string>>;
  setBasementsCount: React.Dispatch<React.SetStateAction<string>>;
  setNotes: React.Dispatch<React.SetStateAction<string>>;
  setPin: React.Dispatch<React.SetStateAction<[number, number] | null>>;
  setGridSize: React.Dispatch<React.SetStateAction<number>>;
  setGridUnits: React.Dispatch<React.SetStateAction<GridUnitDraft[]>>;
  setAcknowledgedDuplicates: React.Dispatch<React.SetStateAction<boolean>>;
  setDuplicateReason: React.Dispatch<React.SetStateAction<string>>;
  setNoPinReason: React.Dispatch<React.SetStateAction<string | null>>;
  draftRestoredRef: React.MutableRefObject<boolean>;
  step: 0 | 1 | 2;
  parcelNumber: string;
  name: string;
  postedNumber: string;
  zoneId: string;
  isPartitioned: boolean;
  partitionNumbers: string[];
  sharedParcels: string[];
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  buildingTypeId: string;
  lifecycleStatus: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED";
  floorsCount: string;
  basementsCount: string;
  notes: string;
  pin: [number, number] | null;
  gridSize: number;
  gridUnits: GridUnitDraft[];
  acknowledgedDuplicates: boolean;
  duplicateReason: string;
  noPinReason: string | null;
  draftBase: string | null;
  pristineRef: React.MutableRefObject<string | null>;
}) {
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const draft = loadBuildingDraft(tenant, buildingId);
    if (!draft) return;

    markDraftBase(draft.baseUpdatedAt ?? null);
    setStep(draft.step);
    setParcelNumber(draft.parcelNumber);
    pinParcelRef.current = draft.parcelNumber.trim() || null;
    setName(draft.name);
    setPostedNumber(draft.postedNumber);
    setZoneId(draft.zoneId);
    setIsPartitioned(draft.isPartitioned);
    setPartitionNumbers(draft.partitionNumbers);
    setSharedParcels(draft.sharedParcels);
    setStructureType(draft.structureType);
    setBuildingTypeId(draft.buildingTypeId ?? '');
    setLifecycleStatus(draft.lifecycleStatus);
    setFloorsCount(draft.floorsCount);
    setBasementsCount(draft.basementsCount);
    setNotes(draft.notes);
    setPin(draft.pin);
    setGridSize(draft.gridSize);
    setGridUnits(draft.gridUnits);
    setAcknowledgedDuplicates(draft.acknowledgedDuplicates);
    setDuplicateReason(draft.duplicateReason ?? '');
    setNoPinReason(draft.noPinReason ?? null);
    draftRestoredRef.current = true;
  }, [tenant, buildingId, markDraftBase, restoredRef, setStep, setParcelNumber, pinParcelRef, setName, setPostedNumber, setZoneId, setIsPartitioned, setPartitionNumbers, setSharedParcels, setStructureType, setBuildingTypeId, setLifecycleStatus, setFloorsCount, setBasementsCount, setNotes, setPin, setGridSize, setGridUnits, setAcknowledgedDuplicates, setDuplicateReason, setNoPinReason, draftRestoredRef]);

  /**
   * Autosave, on every change to anything the officer typed, dropped or
   * painted. Cheap: one `JSON.stringify` of a few fields into sessionStorage.
   */
  useEffect(() => {
    if (!restoredRef.current) return;
    const draft: BuildingDraft = {
      step,
      parcelNumber,
      name,
      postedNumber,
      zoneId,
      isPartitioned,
      partitionNumbers,
      sharedParcels,
      structureType,
      buildingTypeId,
      lifecycleStatus,
      floorsCount,
      basementsCount,
      notes,
      pin,
      gridSize,
      gridUnits,
      acknowledgedDuplicates,
      duplicateReason,
      ...(noPinReason !== null ? { noPinReason } : {}),
      baseUpdatedAt: draftBase,
    };
    /*
      An edit is kept only once it differs from the building as loaded. The
      form holds the building from the moment it loads, so every visit used to
      leave a draft — and the next visit within the hour, after any save to
      the building (a colleague's, or the officer's own on the matrix), asked
      which version to keep about edits nobody had made.
    */
    if (buildingId && editDraftFingerprint(draft) === pristineRef.current) {
      clearBuildingDraft(tenant, buildingId);
      return;
    }
    saveBuildingDraft(tenant, buildingId, draft);
  }, [tenant, buildingId, draftBase, step, parcelNumber, name, postedNumber, zoneId, isPartitioned, partitionNumbers, sharedParcels, structureType, buildingTypeId, lifecycleStatus, floorsCount, basementsCount, notes, pin, gridSize, gridUnits, acknowledgedDuplicates, duplicateReason, noPinReason, restoredRef, pristineRef]);
}
