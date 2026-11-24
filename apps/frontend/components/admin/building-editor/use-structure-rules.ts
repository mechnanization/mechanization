import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isUnsurveyableShell,
} from '@mechanization/shared-schemas';
import {
  DEFAULT_GRID_SIZE,
  type GridUnitDraft,
} from '../unit-grid-picker';
import {
  STEPS,
} from './constants';

/**
 * What the structure's kind decides: a house, a shell, which steps there are, and the matrix a house grows.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useStructureRules({
  structureType,
  editing,
  gridUnits,
  lifecycleStatus,
  scope,
  setStep,
  setFloorsCount,
  setBasementsCount,
  setGridSize,
  setGridUnits,
}: {
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  editing: boolean;
  gridUnits: GridUnitDraft[];
  lifecycleStatus: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED";
  scope: "all" | "info";
  setStep: React.Dispatch<React.SetStateAction<0 | 1 | 2>>;
  setFloorsCount: React.Dispatch<React.SetStateAction<string>>;
  setBasementsCount: React.Dispatch<React.SetStateAction<string>>;
  setGridSize: React.Dispatch<React.SetStateAction<number>>;
  setGridUnits: React.Dispatch<React.SetStateAction<GridUnitDraft[]>>;
}) {
  const isHouse = structureType === 'INDEPENDENT_HOUSE';
  /**
   * A house being *created* is seeded as a single painted block.
   *
   * It used to be seeded and then *hidden*: the matrix step did not exist for a
   * new منزل, on the reasoning that its one unit is «منزل مستقل» by definition
   * and there is nothing left to choose. That reasoning held for the unit and
   * not for the officer. A house has a floor count, it may have a basement, and
   * — far more often than the shortcut allowed for — the thing in front of them
   * turns out not to be a house at all once they have walked round it.
   *
   * So the block is still painted for them, and the step is still shown. One
   * block *is* the house; painting a second one is the officer discovering it
   * is a building, and `requestUnits` below turns that into a question rather
   * than into a save the server refuses.
   */
  const houseShortcut = isHouse && !editing;

  /** Units the census already holds for this building, as loaded. */
  const hasRecordedUnits = useMemo(
    () => gridUnits.some((unit) => unit.existingId),
    [gridUnits],
  );

  /**
   * A structure whose interior cannot be surveyed — «مهدوم» or «متضررة من
   * الحرب و غير مسكونة». There are no storeys to count and no flats to paint,
   * so the wizard stops asking for both.
   *
   * Withheld from a building that already has units on file, and that
   * exception is the important half. Marking a standing block war-damaged is
   * a correction about the shell; its twelve recorded flats still carry
   * occupancies, visits and codes, and hiding the only screen that can reach
   * them would strand them — findable by nobody, fixable from nowhere. The
   * officer gets the matrix, and decides unit by unit what became of each.
   */
  const shellShortcut = isUnsurveyableShell(lifecycleStatus) && !hasRecordedUnits;

  /**
   * Standing, damaged, empty — the full wizard, deliberately. The storeys are
   * countable from the pavement and the flats are what reconstruction is
   * costed on, so this building gets its floor fields and its matrix like any
   * other. Only the notes prompt changes, to ask for what was seen.
   */
  const warDamaged = lifecycleStatus === 'WAR_DAMAGED_UNINHABITED';

  /** An info-only pass never reaches the matrix either — by request rather
   *  than because the structure has none. */
  const infoOnly = scope === 'info';
  /**
   * Only an unsurveyable shell and an info-only pass skip the matrix.
   *
   * A new منزل no longer does — see `houseShortcut`: its one block is painted
   * for the officer and the step stays, so a house that turns out to be a
   * building can be drawn as one («هل تريد تحويلها من منزل إلى بناية؟»).
   */
  const skipsMatrix = shellShortcut || infoOnly;
  /** The last real step — the matrix step doesn't exist for either of them. */
  const lastStep: 0 | 1 | 2 = skipsMatrix ? 1 : 2;
  const visibleSteps = skipsMatrix ? STEPS.slice(0, 2) : STEPS;

  /**
   * The wizard shrinking under the officer's feet must not leave them standing
   * on a step that no longer exists — on an edit every step is clickable, so
   * they can be on the matrix when they set the status to «مهدوم».
   */
  useEffect(() => {
    setStep((current) => (current > lastStep ? lastStep : current));
  }, [lastStep, setStep]);

  /**
   * The fields are hidden, so the values behind them have to be ones the
   * schema accepts rather than whatever was typed before: `floorsCount` is
   * `.min(1)` and would refuse a save with an empty box, and a 4 left over
   * from a guess at a collapsed building is a fabricated observation.
   *
   * 1 and 0 are not claims about the rubble. They are the schema's floor,
   * recorded because something must be, and the notes field below is where
   * what was actually seen goes.
   */
  useEffect(() => {
    if (!shellShortcut) return;
    setFloorsCount('1');
    setBasementsCount('0');
    setGridSize(DEFAULT_GRID_SIZE);
    setGridUnits((current) => current.filter((unit) => unit.existingId));
  }, [setBasementsCount, setFloorsCount, setGridSize, setGridUnits, shellShortcut]);

  /** The reverse: a status corrected back to a standing building gets its
   *  floor count back rather than silently keeping the 1 this shortcut wrote.
   *  Skipped for a house, whose 1 is the truth and whose own effect owns it. */
  const wasShell = useRef(shellShortcut);
  useEffect(() => {
    if (wasShell.current && !shellShortcut && !houseShortcut) {
      setFloorsCount((current) => (current === '1' ? '3' : current));
    }
    wasShell.current = shellShortcut;
  }, [shellShortcut, houseShortcut, setFloorsCount]);

  useEffect(() => {
    if (!houseShortcut || shellShortcut) return;
    setFloorsCount('1');
    /*
      One painted block on a grid with room beside it — not a 1×1 grid.

      What makes it a house is the single *unit*, not a canvas with nowhere to
      draw. Seeded at 1×1 the promotion was unreachable: every cell was already
      taken, so an officer who walked round the back and found a second door had
      to work out that the «أفقي (الأعمدة)» stepper was what stood between them
      and recording it. The question this editor now asks — «هل تريد تحويلها من
      منزل إلى بناية؟» — can only be asked if there is somewhere to paint the
      block that triggers it.

      The height stays at one storey, which is the honest default for a منزل and
      is a stepper away from anything else.
    */
    setGridSize(DEFAULT_GRID_SIZE);
    setGridUnits([
      {
        clientId: crypto.randomUUID(),
        floor: 0,
        startCol: 1,
        endCol: 1,
        unitType: 'INDEPENDENT_HOUSE',
        colorIndex: 0,
      },
    ]);
    /* `shellShortcut` is a dependency, not just a guard: a house marked
       «مهدوم» and then corrected back has had its one unit cleared, and
       without this the effect would not re-run to paint it again. */
  }, [houseShortcut, setFloorsCount, setGridSize, setGridUnits, shellShortcut]);

  /**
   * The officer answered «نعم، هي بناية», so the reset below must not fire.
   *
   * The promotion changes نوع المنشأة, which flips `houseShortcut`, which is
   * exactly the transition the reset watches for — and the reset drops every
   * unpainted unit, which on that commit is the whole floor plan they just
   * confirmed. They would tap «نعم» and watch their matrix collapse to one
   * square, with the structure type silently changed underneath it.
   *
   * A ref rather than state because it must be readable by the effect on the
   * *same* commit that sets it, and it is not something anything renders.
   */
  const promotedFromHouse = useRef(false);

  /** The reverse transition — leaving a structure type of "house" un-paints
   *  the auto-created unit rather than leaving it stranded as a stale 1×1
   *  grid the officer never drew. Units the census already holds survive it:
   *  a structure type is a correction about the shell, not about its flats. */
  const wasHouse = useRef(houseShortcut);
  useEffect(() => {
    if (wasHouse.current && !houseShortcut) {
      if (promotedFromHouse.current) {
        // The grid *is* the reason the type changed. Keep it exactly as drawn.
        promotedFromHouse.current = false;
      } else {
        setGridSize(DEFAULT_GRID_SIZE);
        setGridUnits((current) => current.filter((unit) => unit.existingId));
        setFloorsCount((current) => (current === '1' ? '3' : current));
      }
    }
    wasHouse.current = houseShortcut;
  }, [houseShortcut, setFloorsCount, setGridSize, setGridUnits]);

  /**
   * The grid the officer has painted but not yet been allowed to keep.
   *
   * Held while «هل تريد تحويلها من منزل إلى بناية؟» is on screen — see
   * `requestUnits`.
   */
  const [pendingUnits, setPendingUnits] = useState<GridUnitDraft[] | null>(null);

  /**
   * Every change the matrix makes passes through here, so that one of them can
   * be turned into a question.
   *
   * A منزل مستقل is one dwelling — `assertUnitFits` refuses a second unit on
   * one server-side, and refuses it at *save* time, which is the worst possible
   * moment: the officer has painted a floor plan, walked to the end of the
   * wizard and pressed «إنشاء المبنى», and is told the structure type they
   * chose three screens ago contradicts it.
   *
   * Painting a second block is not a mistake, though. It is the commonest
   * correction there is — the officer walked round the back and found a second
   * door — and the only thing wrong with it is that نوع المنشأة still says
   * «منزل مستقل». So it is asked, here, at the moment it becomes true, and a
   * yes changes the type along with the grid.
   *
   * Only ever intercepts the 1 → 2 crossing. Every other edit — moving a block,
   * widening one, deleting back down — goes straight through, because a
   * question asked on every paint stroke is a question people learn to dismiss.
   */
  const requestUnits = useCallback(
    (next: GridUnitDraft[]) => {
      if (isHouse && next.length > 1) {
        setPendingUnits(next);
        return;
      }
      setGridUnits(next);
    },
    [isHouse, setGridUnits],
  );

  return {
    hasRecordedUnits,
    shellShortcut,
    warDamaged,
    infoOnly,
    skipsMatrix,
    lastStep,
    visibleSteps,
    promotedFromHouse,
    pendingUnits,
    setPendingUnits,
    requestUnits,
  };
}
