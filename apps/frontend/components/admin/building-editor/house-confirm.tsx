'use client';

import {
  defaultUnitTypeFor,
} from '@mechanization/shared-schemas';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_VERTICAL_BLOCKS,
  type GridUnitDraft,
} from '../unit-grid-picker';
import {
  PROMOTED_STRUCTURE_TYPE,
} from './constants';

/**
 * «هل تريد تحويلها من منزل إلى بناية؟»: asked before a second unit is painted under a house.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function HouseConfirm({
  pendingUnits,
  setPendingUnits,
  en,
  promotedFromHouse,
  setStructureType,
  setGridUnits,
  setGridSize,
  setFloorsCount,
}: {
  pendingUnits: GridUnitDraft[] | null;
  setPendingUnits: React.Dispatch<React.SetStateAction<GridUnitDraft[] | null>>;
  en: boolean;
  promotedFromHouse: React.MutableRefObject<boolean>;
  setStructureType: React.Dispatch<React.SetStateAction<"INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION">>;
  setGridUnits: React.Dispatch<React.SetStateAction<GridUnitDraft[]>>;
  setGridSize: React.Dispatch<React.SetStateAction<number>>;
  setFloorsCount: React.Dispatch<React.SetStateAction<string>>;
}): React.JSX.Element {
  return (
    <>
        {/*
        «هل تريد تحويلها من منزل إلى بناية؟»

        Not destructive — nothing is lost and the answer is very often yes, so
        it gets the neutral treatment rather than the red one. What it is, is
        *consequential*: نوع المنشأة decides which property card the citizen's
        file gets (`STRUCTURE_TYPE_MAP`), whether a card can itemise flats at
        all, and — through `assertUnitFits` — whether this save is accepted.

        Declining keeps the house and drops the paint stroke, which is the
        honest outcome: the grid cannot show two units under a type that
        permits one, so there is no half-state to leave the officer in.
      */}
      <ConfirmDialog
        open={pendingUnits !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnits(null);
        }}
        destructive={false}
        title={
          en
            ? 'Change this from a house to a building?'
            : 'هل تريد تحويلها من منزل مستقل إلى بناية؟'
        }
        description={
          en ? (
            <>
              A standalone house is a single dwelling, so it can hold only one unit. You have
              painted {pendingUnits?.length ?? 0}. Confirming changes نوع المنشأة to
              «بناية سكنية» and keeps what you drew.
            </>
          ) : (
            <>
              المنزل المستقل مسكن واحد ولا يقبل أكثر من وحدة، وقد رسمت{' '}
              {pendingUnits?.length ?? 0} وحدات. التأكيد يغيّر «نوع المنشأة» إلى «بناية سكنية»
              ويُبقي ما رسمته.
            </>
          )
        }
        confirmLabel={en ? 'Yes, it is a building' : 'نعم، هي بناية'}
        cancelLabel={en ? 'No, keep it a house' : 'لا، أبقِها منزلاً'}
        busyLabel={en ? 'Working…' : 'جارٍ التنفيذ…'}
        onConfirm={() => {
          const next = pendingUnits;
          setPendingUnits(null);
          if (!next) return;
          /*
            Flagged before the type changes, because changing it is what runs
            the reset that would otherwise throw this grid away — see
            `promotedFromHouse`.
          */
          promotedFromHouse.current = true;
          setStructureType(PROMOTED_STRUCTURE_TYPE);
          /*
            The units are re-typed, not just carried across.

            The block this house was seeded with — and the one the officer
            painted beside it, since the picker defaults from the *current*
            structure type — are both «منزل مستقل». That is not a unit a
            building can contain: `BUILDING_UNIT_TYPES` excludes it precisely
            because a منزل مستقل is what a whole منزل card *is*, and
            `PropertyEntry` refuses it on a مبنى. Left alone, the promotion
            would produce a residential block whose flats are each a standalone
            house — rejected by the card the moment anyone registered a
            household in one, and unselectable in the grid's own edit sheet, so
            the officer could not even correct it by hand.

            Only the ones that say «منزل مستقل» are touched. A محل or a مستودع
            the officer deliberately chose is their answer, and re-typing it
            would be this dialog overruling a decision it was not asked about.

            `defaultUnitTypeFor` rather than a literal «شقة», so a basement
            block comes out as مستودع — the same suggestion the picker would
            have made had the type been right from the start.
          */
          setGridUnits(
            next.map((unit) =>
              unit.unitType === 'INDEPENDENT_HOUSE'
                ? { ...unit, unitType: defaultUnitTypeFor(PROMOTED_STRUCTURE_TYPE, unit.floor) }
                : unit,
            ),
          );
          // The grid has to be at least as wide as what was painted on it: the
          // house seeded a single column, and the second block the officer drew
          // is in the second one.
          setGridSize((current) =>
            Math.max(current, DEFAULT_GRID_SIZE, ...next.map((unit) => unit.endCol)),
          );
          setFloorsCount((current) => (current === '1' ? String(DEFAULT_VERTICAL_BLOCKS) : current));
        }}
      />

    </>
  );
}
