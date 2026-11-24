import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  ApiRequestError,
  createBuilding,
  duplicateBuildingsOf,
  houseGrowthQuestionOf,
  logApiError,
  saveBuildingMatrix,
  type BuildingDetail,
  type BuildingMatrixSave,
  type BuildingMatrixSaveResult,
  type DuplicateBuildingCandidate,
  type HouseGrowthQuestion,
} from '@/lib/api-client';
import {
  clearBuildingDraft,
} from '@/lib/building-draft';
import { offlineStorageAvailable } from '@/lib/offline-db';
import { queueBuilding } from '@/lib/offline-sync';
import { heldInDoubt, heldKey, keyIsSpent, markInDoubt, outcomeInDoubt, spendKey } from '@/lib/request-id';
import { clearSession } from '@/lib/session';
import { useToast } from '@/components/ui/toast';
import {
  flattenGridUnits,
  type GridUnitDraft,
} from '../unit-grid-picker';
import {
  MAX_GRID_UNITS,
} from './constants';
import {
  pinIsAnswered,
} from '@/lib/building-editor-rules';
import { type UnitBaseline } from './grid-units';
import { offlineNow } from './offline-now';

/**
 * The save: the matrix diff, the rehearsal of a correction, the creation under its held key, and the offline queue.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 3) with its code unchanged, in the
 * order it had there: the hooks and effects it holds run in that order, because the
 * call sits where the code did. What it read from the editor's scope is a parameter
 * under the same name, and what the rest of the editor reads from it is returned.
 */
export function useBuildingSave({
  baselineRef,
  loadedUpdatedAtRef,
  name,
  postedNumber,
  isPartitioned,
  cleanedPartitionNumbers,
  cleanedSharedParcels,
  structureType,
  chosenTypeId,
  lifecycleStatus,
  pin,
  floorsCount,
  basementsCount,
  notes,
  infoOnly,
  gridUnits,
  houseGrowth,
  tenant,
  inFlight,
  staleDraft,
  staleDraftRef,
  trimmedParcel,
  setFieldErrors,
  en,
  goToStep,
  pinAnswered,
  setPinError,
  pinVerdict,
  orphanedUnits,
  setError,
  skipsMatrix,
  setSaving,
  editing,
  buildingId,
  token,
  setBuildingReview,
  toast,
  savedCode,
  router,
  base,
  creationScope,
  codePreview,
  suffix,
  duplicateReason,
  noPinReason,
  acknowledgedDuplicates,
  tEditor,
  setGrowthQuestion,
  setDuplicates,
  setAcknowledgedDuplicates,
}: {
  baselineRef: React.MutableRefObject<Map<string, UnitBaseline>>;
  loadedUpdatedAtRef: React.MutableRefObject<string | null>;
  name: string;
  postedNumber: string;
  isPartitioned: boolean;
  cleanedPartitionNumbers: string[];
  cleanedSharedParcels: string[];
  structureType: "INDEPENDENT_HOUSE" | "RESIDENTIAL_BUILDING" | "COMMERCIAL_CENTER" | "WAREHOUSE_HANGAR" | "MIXED_USE" | "TENT_SHELTER" | "PUBLIC_INSTITUTION";
  chosenTypeId: string;
  lifecycleStatus: "UNDER_CONSTRUCTION" | "PERMITTED" | "IN_USE" | "DERELICT" | "WAR_DAMAGED_UNINHABITED" | "DEMOLISHED" | "NOT_REALISED";
  pin: [number, number] | null;
  floorsCount: string;
  basementsCount: string;
  notes: string;
  infoOnly: boolean;
  gridUnits: GridUnitDraft[];
  houseGrowth: "EXTRA_LEVEL" | "SEPARATE_UNIT" | null;
  tenant: string;
  inFlight: React.MutableRefObject<boolean>;
  staleDraft: BuildingDetail | null;
  staleDraftRef: React.MutableRefObject<HTMLDivElement | null>;
  trimmedParcel: string;
  setFieldErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  en: boolean;
  goToStep: (next: 0 | 1 | 2) => void;
  pinAnswered: ReturnType<typeof pinIsAnswered>;
  setPinError: React.Dispatch<React.SetStateAction<string | null>>;
  pinVerdict: boolean | null;
  orphanedUnits: GridUnitDraft[];
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  skipsMatrix: boolean;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
  editing: boolean;
  buildingId: string | undefined;
  token: string | undefined;
  setBuildingReview: React.Dispatch<React.SetStateAction<{ save: BuildingMatrixSave; result: BuildingMatrixSaveResult; } | null>>;
  toast: ReturnType<typeof useToast>;
  savedCode: string | null;
  router: ReturnType<typeof useRouter>;
  base: string;
  creationScope: `building:${string}`;
  codePreview: string | null;
  suffix: string;
  duplicateReason: string;
  noPinReason: string | null;
  acknowledgedDuplicates: boolean;
  tEditor: ReturnType<typeof useTranslations<'buildingEditor'>>;
  setGrowthQuestion: React.Dispatch<React.SetStateAction<HouseGrowthQuestion | null>>;
  setDuplicates: React.Dispatch<React.SetStateAction<DuplicateBuildingCandidate[] | null>>;
  setAcknowledgedDuplicates: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  /**
   * A correction, as one request: the shell and the difference between the
   * matrix that was loaded and the one now on the grid (`saveMatrix`).
   *
   * A diff rather than a re-send, because the units on a standing building are
   * not the wizard's to recreate — they carry occupancies, visits and codes
   * the server derived, and deleting and re-adding one would take a flat's
   * whole history down with it.
   *
   * All or nothing. It used to be one PATCH and then one request per unit,
   * each refusal collected while the rest went through — so a flat somebody
   * lived in could refuse its removal while the four beside it were removed,
   * and the officer was left with «حُفظ المبنى، لكن رُفض…»: a building half in
   * the state they meant. Now the first refusal names its unit and nothing is
   * written; the grid on screen is still the officer's, to fix and save again.
   * The server runs the removals before the shell, so lowering the floor count
   * with the top floor's units no longer needs a second request.
   *
   * On «تعديل معلومات المبنى» the matrix was never shown, so no unit is sent:
   * a diff of a grid nobody saw could only compare the building to itself.
   */
  const matrixSave = (): BuildingMatrixSave => {
    const baseline = baselineRef.current;
    const changed = (unit: GridUnitDraft) => {
      const was = unit.existingId ? baseline.get(unit.existingId) : undefined;
      return (
        was !== undefined &&
        (was.floor !== unit.floor ||
          was.startCol !== unit.startCol ||
          was.endCol !== unit.endCol ||
          was.unitType !== unit.unitType ||
          (was.unitTypeId ?? undefined) !== (unit.unitTypeId ?? undefined))
      );
    };
    return {
      ...(loadedUpdatedAtRef.current ? { expectedUpdatedAt: loadedUpdatedAtRef.current } : {}),
      building: {
        name: name.trim() || null,
        postedNumber: postedNumber.trim() || null,
        /*
          `null` and not `false` for an unticked box — «لم يُسأل», not a denial.
          Sent rather than omitted, so a فرز ticked by mistake can be withdrawn;
          the server clears the numbers whenever the flag is not true.
        */
        isPartitioned: isPartitioned ? true : null,
        partitionNumbers: cleanedPartitionNumbers,
        sharedParcelNumbers: cleanedSharedParcels,
        structureType,
        ...(chosenTypeId ? { buildingTypeId: chosenTypeId } : {}),
        lifecycleStatus,
        latitude: pin ? pin[1] : null,
        longitude: pin ? pin[0] : null,
        floorsCount: Number(floorsCount) || 1,
        basementsCount: Number(basementsCount) || 0,
        notes: notes.trim() || null,
      },
      remove: infoOnly
        ? []
        : [...baseline.keys()].filter((unitId) => !gridUnits.some((unit) => unit.existingId === unitId)),
      update: infoOnly
        ? []
        : gridUnits.filter(changed).map((unit) => ({
            id: unit.existingId as string,
            floor: unit.floor,
            startCol: unit.startCol,
            endCol: unit.endCol,
            unitType: unit.unitType,
            ...(unit.unitTypeId ? { unitTypeId: unit.unitTypeId } : {}),
          })),
      add: infoOnly
        ? []
        : gridUnits
            .filter((unit) => !unit.existingId)
            .map((unit) => ({
              floor: unit.floor,
              startCol: unit.startCol,
              endCol: unit.endCol,
              unitType: unit.unitType,
              ...(unit.unitTypeId ? { unitTypeId: unit.unitTypeId } : {}),
            })),
      ...(houseGrowth ? { houseGrowth } : {}),
    };
  };

  const saveEdit = async (id: string, activeToken: string): Promise<void> => {
    await saveBuildingMatrix(tenant, activeToken, id, matrixSave());
  };

  // Save handler
  const handleSave = async (confirmed = false) => {
    if (inFlight.current) return;
    // Which version to keep is asked first (`staleDraft`); the question is where the answer is.
    if (staleDraft) {
      staleDraftRef.current?.focus();
      return;
    }
    if (!trimmedParcel) {
      setFieldErrors({ parcelNumber: en ? 'Parcel number is required' : 'رقم العقار مطلوب' });
      goToStep(0);
      return;
    }
    if (!pinAnswered) {
      setPinError(
        en
          ? 'Pin the entrance on the map, or tick that it could not be pinned and say why.'
          : 'ثبِّت المدخل على الخريطة، أو أشِر إلى تعذّر ذلك واذكر السبب.',
      );
      goToStep(0);
      return;
    }
    if (pin && pinVerdict === false) {
      setPinError(
        en
          ? 'The entrance pin is outside the parcel boundary. Relocate it or clear it before saving.'
          : 'دبوس المدخل خارج حدود العقار. حرّكه أو احذفه قبل الحفظ.',
      );
      goToStep(0);
      return;
    }
    if (orphanedUnits.length > 0) {
      setError(
        en
          ? `${orphanedUnits.length} unit(s) are on floors above the current floor count (${floorsCount}). Raise the floor count or remove them from the matrix.`
          : `${orphanedUnits.length} وحدة موضوعة على طوابق أعلى من عدد الطوابق الحالي (${floorsCount}). ارفع عدد الطوابق أو احذف هذه الوحدات من المصفوفة.`,
      );
      // The matrix step, because that is where the floor count now lives —
      // both halves of the fix this message asks for are on the same screen.
      // A pass with no matrix step (a shell, «تعديل معلومات المبنى») stays put.
      goToStep(skipsMatrix ? 1 : 2);
      return;
    }

    /** Only the flats this save has to create — an edit's existing units are
     *  already rows and are diffed, not re-sent. */
    const units = flattenGridUnits(gridUnits.filter((unit) => !unit.existingId));
    if (units.length > MAX_GRID_UNITS) {
      setError(
        en
          ? `${units.length} units is more than the maximum of ${MAX_GRID_UNITS} allowed at once.`
          : `عدد الوحدات (${units.length}) يتجاوز الحد الأقصى ${MAX_GRID_UNITS} في العملية الواحدة.`,
      );
      return;
    }

    inFlight.current = true;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    /** Set once a save has landed: the form then stays locked while the page moves on. */
    let landed = false;

    try {
      if (editing && buildingId) {
        if (!token) {
          throw new Error(
            en ? 'Session expired. Please sign in again.' : 'انتهت الجلسة. يرجى تسجيل الدخول مجدداً.',
          );
        }

        /*
          «مراجعة التعديلات» first: the save rehearsed on the server and rolled
          back (`dryRun`), so the review shows what the server would actually
          do — which units go, move and arrive — or the refusal it would give,
          before the officer confirms anything.

          All or nothing either way: a refusal throws before anything is
          written and lands in the catch below with the unit it names, and the
          grid on screen is still exactly what the officer drew.
        */
        if (!confirmed) {
          const save = matrixSave();
          const result = await saveBuildingMatrix(tenant, token, buildingId, { ...save, dryRun: true });
          setBuildingReview({ save, result });
          setSaving(false);
          return;
        }
        await saveEdit(buildingId, token);
        landed = true;

        clearBuildingDraft(tenant, buildingId);
        toast.success(
          en ? `Building ${savedCode ?? ''} updated` : `تم تحديث المبنى ${savedCode ?? ''}`,
        );
        router.push(`${base}/buildings/${encodeURIComponent(buildingId)}/matrix`);
        return;
      }

      // 1. Offline branch
      if (offlineNow() && offlineStorageAvailable()) {
        await queueBuilding({
          /*
            The id an online attempt at this same building may already have
            sent: an answer that never arrived often means a request that did,
            and under the same id the drain is answered with that building —
            as that press sent it, so the queue says so (`afterLostAnswer`).
          */
          id: heldKey(tenant, creationScope),
          ...(heldInDoubt(tenant, creationScope) ? { afterLostAnswer: true } : {}),
          tenant,
          parcelNumber: trimmedParcel,
          provisionalCode: codePreview ?? trimmedParcel,
          provisionalSuffix: suffix,
          payload: {
            parcelNumber: trimmedParcel,
            name: name.trim() || undefined,
            postedNumber: postedNumber.trim() || undefined,
            // Omitted when the box was not ticked, matching the create schema:
            // an absent key and a null mean the same thing on a *creation*, and
            // the queue's payload is replayed through `createBuilding`.
            ...(isPartitioned
              ? { isPartitioned: true, partitionNumbers: cleanedPartitionNumbers }
              : {}),
            ...(cleanedSharedParcels.length > 0
              ? { sharedParcelNumbers: cleanedSharedParcels }
              : {}),
            structureType,
            ...(chosenTypeId ? { buildingTypeId: chosenTypeId } : {}),
            lifecycleStatus,
            latitude: pin ? pin[1] : undefined,
            longitude: pin ? pin[0] : undefined,
            floorsCount: Number(floorsCount) || 1,
            basementsCount: Number(basementsCount) || 0,
            notes: notes.trim() || undefined,
            acknowledgedDuplicates: true,
            ...(duplicateReason.trim() ? { duplicateReason: duplicateReason.trim() } : {}),
            ...(!pin && noPinReason?.trim() ? { noPinReason: noPinReason.trim() } : {}),
            units,
          },
          blueprint: null,
        });
        landed = true;
        // The queue holds the id now; the next building on this parcel is another act.
        spendKey(tenant, creationScope);

        clearBuildingDraft(tenant, buildingId);
        toast.info(en ? 'Saved on this device' : 'حُفظ على هذا الجهاز', {
          description: en
            ? `${codePreview ?? trimmedParcel} is provisional until network sync restores.`
            : `الرمز ${codePreview ?? trimmedParcel} مؤقت وسيُرسل للخادم فور توفّر الاتصال.`,
        });

        router.push(`${base}/buildings`);
        return;
      }

      if (!token) {
        throw new Error(en ? 'Session expired. Please sign in again.' : 'انتهت الجلسة. يرجى تسجيل الدخول مجدداً.');
      }

      // 2. Online: create the building shell and its units in one transactional call
      const response = await createBuilding(tenant, token, {
        parcelNumber: trimmedParcel,
        name: name.trim() || undefined,
        postedNumber: postedNumber.trim() || undefined,
        ...(isPartitioned
          ? { isPartitioned: true, partitionNumbers: cleanedPartitionNumbers }
          : {}),
        ...(cleanedSharedParcels.length > 0
          ? { sharedParcelNumbers: cleanedSharedParcels }
          : {}),
        structureType,
        ...(chosenTypeId ? { buildingTypeId: chosenTypeId } : {}),
        lifecycleStatus,
        latitude: pin ? pin[1] : undefined,
        longitude: pin ? pin[0] : undefined,
        floorsCount: Number(floorsCount) || 1,
        basementsCount: Number(basementsCount) || 0,
        notes: notes.trim() || undefined,
        provisionalSuffix: suffix,
        acknowledgedDuplicates: acknowledgedDuplicates || undefined,
        ...(acknowledgedDuplicates && duplicateReason.trim()
          ? { duplicateReason: duplicateReason.trim() }
          : {}),
        ...(!pin && noPinReason?.trim() ? { noPinReason: noPinReason.trim() } : {}),
        units,
        clientSubmissionId: heldKey(tenant, creationScope),
      });
      landed = true;
      spendKey(tenant, creationScope);

      const saved = response.building;
      const reconciled = response.reconciled;

      /* On file now, so the draft has done its job. Cleared before the toasts
         rather than after the redirect: the officer may press «مبنى جديد»
         straight from the list, and restoring the building they just created
         into a form headed «مبنى جديد» is worse than no restore at all. */
      clearBuildingDraft(tenant, buildingId);

      /*
        An earlier press reached the server and its answer was lost: this is
        that building, not a new one, and what it holds is what that press
        sent — so the officer is told, and checks it on the matrix.
      */
      if (response.deduplicated) {
        toast.warning(tEditor('deduplicated.title'), {
          description: tEditor('deduplicated.description', { code: saved.code }),
        });
      }

      if (reconciled) {
        toast.warning(en ? 'Building code allocated' : 'تغيّر رمز المبنى عند الحفظ', {
          description: en
            ? `Another building already claimed that letter. Allocated code: ${saved.code}.`
            : `تم اعتماد الرمز النهائي المخصّص من الخادم: ${saved.code}.`,
        });
      } else if (!response.deduplicated) {
        toast.success(
          en ? `Building ${saved.code} created` : `تم إنشاء المبنى ${saved.code}`,
          {
            description:
              units.length > 0
                ? en
                  ? `${units.length} units created at «not surveyed».`
                  : `تم إنشاء ${units.length} وحدة بحالة «غير ممسوحة».`
                : undefined,
          },
        );
      }

      // Land on the full-page unit matrix — the tool for filling in any
      // floors the chosen grid size didn't cover.
      router.push(`${base}/buildings/${encodeURIComponent(saved.id)}/matrix`);
    } catch (caught) {
      logApiError(caught);
      /*
        A creation's key is kept across every failure (`keyIsSpent` names none
        a building can meet), and marked when the answer was lost: the building
        may exist, and a fall-back to the queue says so (`afterLostAnswer`).
      */
      if (!editing) {
        if (keyIsSpent(caught)) spendKey(tenant, creationScope);
        else if (outcomeInDoubt(caught)) markInDoubt(tenant, creationScope);
      }

      // A house on somebody's file would grow: ask, then rehearse again with the answer (D28).
      const question = houseGrowthQuestionOf(caught);
      if (question) {
        setGrowthQuestion(question);
        return;
      }

      const candidates = duplicateBuildingsOf(caught);
      if (candidates) {
        setDuplicates(candidates);
        setAcknowledgedDuplicates(false);
        setError((caught as ApiRequestError).payload.message);
        goToStep(1);
        return;
      }

      if (caught instanceof ApiRequestError) {
        if (caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        setFieldErrors(caught.fieldErrors);
        setError(caught.payload.message);
      } else {
        setError(en ? 'Could not save the building.' : 'تعذّر حفظ المبنى.');
      }
    } finally {
      // After a save that landed the button stays off: the page is leaving (see `inFlight`).
      if (!landed) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  };

  /*
    The answer to «هذا المنزل يصبح مبنى» goes straight back into the rehearsal:
    once the state holds it, so the next `matrixSave()` sends it. The officer
    sees the review, not a second press of «حفظ» with nothing to say why.
  */
  const rehearseAfterAnswer = useRef(false);
  useEffect(() => {
    if (!houseGrowth || !rehearseAfterAnswer.current) return;
    rehearseAfterAnswer.current = false;
    void handleSave();
    // Fires on the answer only; `handleSave` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houseGrowth]);

  return {
    handleSave,
    rehearseAfterAnswer,
  };
}
