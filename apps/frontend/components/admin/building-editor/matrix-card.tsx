'use client';

import type { BuildingTypeView } from '@mechanization/shared-schemas';
import { useTranslations } from 'next-intl';
import {
  ClipboardCheck,
  Info,
} from 'lucide-react';
import {
  type UnitWithOccupants,
} from '@/lib/api-client';
import { systemTypeOf, useBuildingTypes } from '@/lib/building-types';
import { useUnitTypes } from '@/lib/unit-types';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  UnitGridPicker,
  type GridUnitDraft,
} from '../unit-grid-picker';

/**
 * The unit matrix step: the floor counts and the grid.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function MatrixCard({
  en,
  locale,
  structureType,
  chosenType,
  setStructureType,
  setBuildingTypeId,
  buildingTypes,
  floorsCount,
  setFloorsCount,
  basementsCount,
  setBasementsCount,
  gridSize,
  setGridSize,
  gridUnits,
  unitTypes,
  requestUnits,
  lifecycleStatus,
  topGap,
  tFloors,
  hiddenUnits,
}: {
  en: boolean;
  locale: string;
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  chosenType: BuildingTypeView | undefined;
  setStructureType: React.Dispatch<React.SetStateAction<"INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION">>;
  setBuildingTypeId: React.Dispatch<React.SetStateAction<string>>;
  buildingTypes: ReturnType<typeof useBuildingTypes>;
  floorsCount: string;
  setFloorsCount: React.Dispatch<React.SetStateAction<string>>;
  basementsCount: string;
  setBasementsCount: React.Dispatch<React.SetStateAction<string>>;
  gridSize: number;
  setGridSize: React.Dispatch<React.SetStateAction<number>>;
  gridUnits: GridUnitDraft[];
  unitTypes: ReturnType<typeof useUnitTypes>;
  requestUnits: (next: GridUnitDraft[]) => void;
  lifecycleStatus: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED";
  topGap: { empty: number; suggested: number; } | null;
  tFloors: ReturnType<typeof useTranslations<'floorCount'>>;
  hiddenUnits: UnitWithOccupants[];
}): React.JSX.Element {
  return (
    <>
      <Card className="shadow-xs border-border/80">
        <CardHeader className="border-b bg-muted/15 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ClipboardCheck className="size-4" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">
                {en ? 'Unit Matrix' : 'مصفوفة الوحدات'}
              </CardTitle>

            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-5">
          <UnitGridPicker
            locale={locale}
            structureType={structureType}
            defaultUnitType={chosenType?.defaultUnitType}
            onStructureTypeChange={(next) => {
              // The grid re-typed the structure (a lone house): its system type follows (0106).
              setStructureType(next);
              setBuildingTypeId(systemTypeOf(buildingTypes.data ?? [], next)?.id ?? '');
            }}
            floorsCount={Number(floorsCount) || 1}
            onFloorsCountChange={(newFloors) => setFloorsCount(String(newFloors))}
            basementsCount={Number(basementsCount) || 0}
            onBasementsCountChange={(next) => setBasementsCount(String(next))}
            gridSize={gridSize}
            onGridSizeChange={setGridSize}
            units={gridUnits}
            unitTypes={unitTypes.data ?? undefined}
            // Not `setGridUnits` — a house gaining a second block is a
            // question before it is a change. See `requestUnits`.
            onUnitsChange={requestUnits}
            unfinished={lifecycleStatus === 'PERMITTED' || lifecycleStatus === 'UNDER_CONSTRUCTION'}
          />

          {topGap ? (
            <Alert variant="warning" role="status">
              {tFloors('emptyTop', { count: topGap.empty })}
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setFloorsCount(String(topGap.suggested))}
                >
                  {tFloors('trimTo', { count: topGap.suggested })}
                </Button>
              </div>
            </Alert>
          ) : null}

          {/*
            Units the grid has no row for — basements, which it does not
            draw, and anything past its width. Named rather than omitted:
            an officer who cannot see a flat here must still know it is on
            file, and the save leaves every one of them untouched.
          */}
          {hiddenUnits.length > 0 ? (
            <p className="flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {en
                  ? `${hiddenUnits.length} unit(s) are not drawn on this grid (${hiddenUnits
                      .map((unit) => unit.unitCode)
                      .join(', ')}) — they are left exactly as they are. Correct them from the unit matrix.`
                  : `${hiddenUnits.length} وحدة غير معروضة على هذه المصفوفة (${hiddenUnits
                      .map((unit) => unit.unitCode)
                      .join('، ')}) — تبقى كما هي دون تغيير. صحّحها من صفحة مصفوفة الوحدات.`}
              </span>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
