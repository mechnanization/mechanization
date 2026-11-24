'use client';

import type { BuildingTypeView } from '@mechanization/shared-schemas';
import { useTranslations } from 'next-intl';
import {
  BUILDING_LIFECYCLE,
  getLabels,
  isOccupiableLifecycle,
  isUninhabitableLifecycle,
  isUnsurveyableShell,
  STRUCTURE_TYPE,
  buildingTypeName,
  type BuildingLifecycle,
  type StructureType,
} from '@mechanization/shared-schemas';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * The facility step's fields: name, type, status, and the notes under each.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function FacilityFields({
  tTypes,
  fieldErrors,
  offeredTypes,
  chosenTypeId,
  chooseType,
  locale,
  structureType,
  setStructureType,
  labels,
  en,
  lifecycleStatus,
  setLifecycleStatus,
  tFeeExemption,
  editing,
  liveOccupants,
  loadedLifecycle,
  hasRecordedUnits,
}: {
  tTypes: ReturnType<typeof useTranslations<'buildingTypes'>>;
  fieldErrors: Record<string, string>;
  offeredTypes: BuildingTypeView[];
  chosenTypeId: string;
  chooseType: (id: string) => void;
  locale: string;
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  setStructureType: React.Dispatch<React.SetStateAction<"INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION">>;
  labels: ReturnType<typeof getLabels>;
  en: boolean;
  lifecycleStatus: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED";
  setLifecycleStatus: React.Dispatch<React.SetStateAction<"UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED">>;
  tFeeExemption: ReturnType<typeof useTranslations<'feeExemption'>>;
  editing: boolean;
  liveOccupants: number;
  loadedLifecycle: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED" | null;
  hasRecordedUnits: boolean;
}): React.JSX.Element {
  return (
    <>
      <div className="grid gap-4">
        <Field
          label={tTypes('picker')}
          htmlFor="building-structure-type"
          required
          error={fieldErrors.structureType}
        >
          {offeredTypes.length > 0 ? (
            <Select value={chosenTypeId} onValueChange={chooseType}>
              <SelectTrigger id="building-structure-type" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {offeredTypes.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {buildingTypeName(type, locale)}
                    {type.isActive ? '' : ` — ${tTypes('inactive')}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            // No list on this device yet and no network: the structures, as before types existed.
            <Select
              value={structureType}
              onValueChange={(value) => setStructureType(value as StructureType)}
            >
              <SelectTrigger id="building-structure-type" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRUCTURE_TYPE.map((type) => (
                  <SelectItem key={type} value={type}>
                    {labels.structureType[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>

        <Field
          label={en ? 'Construction Status' : 'الحالة الإنشائية'}
          htmlFor="building-lifecycle"
          required
          error={fieldErrors.lifecycleStatus}

        >
          <Select
            value={lifecycleStatus}
            onValueChange={(value) => setLifecycleStatus(value as BuildingLifecycle)}
          >
            <SelectTrigger id="building-lifecycle" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUILDING_LIFECYCLE.map((status) => (
                <SelectItem key={status} value={status}>
                  {labels.buildingLifecycle[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {/*
        «متضررة من الحرب وغير مسكونة» or «مهدوم» exempts nothing by itself
        (decision of 2026-10-07): a damage reading «غير صالحة للسكن» does,
        because it records who judged it, when and on what, and a later
        reading ends it. Said here, where the label is chosen; «مراجعة
        الجودة» lists the building until the reading is recorded.
      */}
      {isUninhabitableLifecycle(lifecycleStatus) ? (
        <Alert variant="info" role="note">
          {tFeeExemption('lifecycleNote')}
        </Alert>
      ) : null}

      {/*
        A building leaving «قائم ومستعمل» with people still recorded in it.

        The lifecycle is a statement about the structure; nothing reads
        it when deciding who is billed. So «مهدوم» on a building whose
        flats still hold a tenant leaves that tenant housed and charged
        in a building that is gone — until somebody ends each occupancy.
        Said before saving, with where to do it, rather than left to a
        resident disputing the bill.
      */}
      {editing &&
      liveOccupants > 0 &&
      loadedLifecycle !== null &&
      isOccupiableLifecycle(loadedLifecycle) &&
      !isOccupiableLifecycle(lifecycleStatus) ? (
        <Alert variant="warning" role="note">
          {en
            ? `${liveOccupants} occupancy record(s) are still current in this building's units, and they keep being billed. Changing the building's status does not end them — after saving, end each one from the unit matrix («End tenancy» for a tenant; a new status for an owner's unit).`
            : `ما زال ${liveOccupants} إشغال قائماً على وحدات هذا المبنى، ويُحصَّل الرسم منه. تغيير حالة المبنى لا يُنهيه — بعد الحفظ أنهِ كل إشغال من مصفوفة الوحدات («إنهاء الإيجار» للمستأجر، وحالة جديدة لوحدة المالك).`}
        </Alert>
      ) : null}

      {/*
        Said out loud, because two things vanish at once — the floor
        fields above and the matrix step in the rail — and a form that
        quietly drops half of itself reads as a bug. The second line is
        the one that matters on an edit: it explains why a building
        that already has flats keeps its matrix while this one loses it.
      */}
      {isUnsurveyableShell(lifecycleStatus) ? (
        <Alert
          variant="info"
          title={en
            ? 'Structure classified as demolished — there are no storeys left to count, so the floor fields and the unit matrix are skipped automatically.'
            : 'المنشأة مصنَّفة مهدومة — لم يبقَ طوابق تُعدّ، لذا يُتخطّى عدد الطوابق ومصفوفة الوحدات تلقائياً.'}
        >
          {hasRecordedUnits
            ? en
              ? 'This building already has units on file, so the matrix stays available — record what became of each one there.'
              : 'لهذا المبنى وحدات مسجَّلة مسبقاً، لذا تبقى المصفوفة متاحة — سجِّل مصير كل وحدة فيها.'
            : en
              ? 'Describe what was observed in the field notes below.'
              : 'دوِّن ما شوهد ميدانياً في الملاحظات أدناه.'}
        </Alert>
      ) : null}

    </>
  );
}
