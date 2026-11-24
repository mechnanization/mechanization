'use client';

import { useTranslations } from 'next-intl';
import {
  type BuildingDetail,
  type HouseGrowthQuestion,
} from '@/lib/api-client';
import { HouseGrowthPrompt } from '@/components/admin/unit-levels';
import { floorLabel } from '@/components/admin/building-unit-forms';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  type GridUnitDraft,
} from '../unit-grid-picker';

/**
 * What sits above the step: the stale-draft question, the house-growth prompt and the save's error.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function EditorNotices({
  staleDraft,
  staleDraftRef,
  tEditor,
  loadLatestVersion,
  keepDraftOverLatest,
  growthQuestion,
  gridUnits,
  en,
  structureType,
  saving,
  locale,
  rehearseAfterAnswer,
  setHouseGrowth,
  setGrowthQuestion,
  error,
}: {
  staleDraft: BuildingDetail | null;
  staleDraftRef: React.MutableRefObject<HTMLDivElement | null>;
  tEditor: ReturnType<typeof useTranslations<'buildingEditor'>>;
  loadLatestVersion: () => void;
  keepDraftOverLatest: () => void;
  growthQuestion: HouseGrowthQuestion | null;
  gridUnits: GridUnitDraft[];
  en: boolean;
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  saving: boolean;
  locale: string;
  rehearseAfterAnswer: React.MutableRefObject<boolean>;
  setHouseGrowth: React.Dispatch<React.SetStateAction<"EXTRA_LEVEL" | "SEPARATE_UNIT" | null>>;
  setGrowthQuestion: React.Dispatch<React.SetStateAction<HouseGrowthQuestion | null>>;
  error: string | null;
}): React.JSX.Element {
  return (
    <>
      {staleDraft ? (
        <Alert
          ref={staleDraftRef}
          id="building-stale-draft"
          tabIndex={-1}
          variant="warning"
          live="status"
          title={tEditor('staleDraft.title')}
        >
          <div className="space-y-3">
            <p>{tEditor('staleDraft.body')}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={loadLatestVersion}>
                {tEditor('staleDraft.loadLatest')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={keepDraftOverLatest}>
                {tEditor('staleDraft.keepDraft')}
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {growthQuestion ? (
        <HouseGrowthPrompt
          question={growthQuestion}
          // The lowest floor this save paints on — where a level of the house would go.
          floor={Math.min(
            ...gridUnits.filter((unit) => !unit.existingId).map((unit) => unit.floor),
            growthQuestion.nextLevelFloor,
          )}
          floorText={(floor) => floorLabel(floor, en)}
          structureIsHouse={structureType === 'INDEPENDENT_HOUSE'}
          busy={saving}
          locale={locale}
          onAnswer={(growth) => {
            rehearseAfterAnswer.current = true;
            setHouseGrowth(growth);
            setGrowthQuestion(null);
          }}
          onCancel={() => setGrowthQuestion(null)}
        />
      ) : null}

      {/* Global Error Banner */}
      {error ? (
        <Alert
          variant="destructive"
          live="alert"
          title={en ? 'Unable to save building' : 'تعذّر حفظ المبنى'}
        >
          {error}
        </Alert>
      ) : null}
    </>
  );
}
