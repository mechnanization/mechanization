import { useMemo } from 'react';
import {
  type DuplicateBuildingCandidate,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import {
  type GridUnitDraft,
} from '../unit-grid-picker';
import {
  MIN_DUPLICATE_REASON,
} from './constants';
import {
  bottomFloorFor,
  orphanedUnitsOf,
  pinIsAnswered,
  rankDuplicates,
  topFloorFor,
  topGapOf,
} from '@/lib/building-editor-rules';

/**
 * The gates between the steps, and moving between them.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useStepGates({
  floorsCount,
  gridUnits,
  hiddenUnits,
  lifecycleStatus,
  basementsCount,
  editing,
  pin,
  noPinReason,
  trimmedParcel,
  pinVerdict,
  acknowledgedDuplicates,
  duplicateReason,
  duplicates,
  setStep,
  rootRef,
  step,
  lastStep,
}: {
  floorsCount: string;
  gridUnits: GridUnitDraft[];
  hiddenUnits: UnitWithOccupants[];
  lifecycleStatus: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED";
  basementsCount: string;
  editing: boolean;
  pin: [number, number] | null;
  noPinReason: string | null;
  trimmedParcel: string;
  pinVerdict: boolean | null;
  acknowledgedDuplicates: boolean;
  duplicateReason: string;
  duplicates: DuplicateBuildingCandidate[] | null;
  setStep: React.Dispatch<React.SetStateAction<0 | 1 | 2>>;
  rootRef: React.MutableRefObject<HTMLDivElement | null>;
  step: 0 | 1 | 2;
  lastStep: 0 | 1 | 2;
}) {
  const topFloorAllowed = topFloorFor(floorsCount);

  /*
    Top rows with nothing in them — the roof counted as a floor, most often
    (`emptyTopFloors`). Not asked of a building still going up: its top floors
    are expected to be empty.
  */
  const topGap = useMemo(
    () => topGapOf(gridUnits, hiddenUnits, floorsCount, lifecycleStatus),
    [gridUnits, hiddenUnits, floorsCount, lifecycleStatus],
  );
  const bottomFloorAllowed = bottomFloorFor(basementsCount);

  /** Confirmed grid units left stranded if the officer narrows the building
   *  past where they were painted — above the top floor or below the deepest
   *  basement. Never silently dropped. */
  const orphanedUnits = useMemo(
    () => orphanedUnitsOf(gridUnits, topFloorAllowed, bottomFloorAllowed),
    [gridUnits, topFloorAllowed, bottomFloorAllowed],
  );

  // ── Per-step validation gates ──
  /*
    A new building either has its entrance pinned, or says why not.

    The pin is what the duplicate prompt measures from: without it an officer
    on a parcel that already holds a structure is shown codes, not «على بُعد ٤ م».
    Eight buildings went on file with no pin and no word about it. A correction
    is not held to this — the building is already on file, pinned or not.
  */
  const pinAnswered = pinIsAnswered(editing, pin, noPinReason);
  const step1Valid = Boolean(trimmedParcel) && !(pin && pinVerdict === false) && pinAnswered;
  /*
    What stops «التالي» on the facility step.

    `orphanedUnits` used to be part of this and no longer is, because the two
    things that resolve it — the floor count and the matrix — are both on the
    step this gate guards the way *to*. Holding an officer on the previous
    screen until they fix something they can only reach by leaving it is a dead
    end, and the save still refuses the same condition with a message that now
    sends them to the right place.

    The height and depth checks stay as assertions rather than as live gates:
    nothing on this step can set them any more, so they can only fail if some
    other path has put nonsense in the state.
  */
  const duplicateAnswered =
    acknowledgedDuplicates && duplicateReason.trim().length >= MIN_DUPLICATE_REASON;
  const step2Valid =
    !(duplicates?.length && !duplicateAnswered) &&
    Number(floorsCount) >= 1 &&
    Number(basementsCount) >= 0;

  /**
   * The structures already on this parcel, nearest first, measured from the pin
   * as it stands now.
   *
   * The server measures too, but only on a refused save; the list shown while
   * the officer is still on the step comes from the parcel lookup, before any
   * pin existed, and carried `distanceMetres: null`. So the distance is worked
   * out here from the two pins and follows the officer's own pin as they move
   * it. Parcel 56's second and third records were made 3.6 m and 4.1 m from
   * the first by officers shown a list with no distance on it.
   */
  const rankedDuplicates = useMemo(() => rankDuplicates(duplicates, pin), [duplicates, pin]);

  /**
   * Moving between steps puts the top of the new step back on screen.
   *
   * «التالي» lives at the *bottom* of the wizard and the step it opens starts
   * at the top. Without this, pressing it from the foot of a long step — the
   * summary card at the end of «معلومات المنشأة», say — leaves the reader
   * looking at the footer of a step they have never seen, with the first
   * question a screen and a half above them. On a phone that reads as the
   * button having done nothing.
   *
   * Both directions, and the step rail too: every one of them replaces the
   * whole body of the card.
   */
  const goToStep = (next: 0 | 1 | 2) => {
    setStep(next);
    scrollElementToTop(rootRef.current);
  };

  const goNext = () => goToStep((step < lastStep ? step + 1 : step) as 0 | 1 | 2);
  const goBack = () => goToStep((step > 0 ? step - 1 : step) as 0 | 1 | 2);

  return {
    topGap,
    orphanedUnits,
    pinAnswered,
    step1Valid,
    step2Valid,
    rankedDuplicates,
    goToStep,
    goNext,
    goBack,
  };
}
