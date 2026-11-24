'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  ChevronRight,
  Loader2,
  MapPin,
} from 'lucide-react';
import {
  getLabels,
} from '@mechanization/shared-schemas';
import { BuildingReviewDialog } from '@/components/admin/building-review-dialog';
import {
  clearBuildingDraft,
} from '@/lib/building-draft';
import { useStaffSession } from '@/lib/use-staff-session';
import { CENSUS_WRITE_ROLES, hasRole } from '@/lib/staff-roles';
import { useBuildingTypes } from '@/lib/building-types';
import { useUnitTypes } from '@/lib/unit-types';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { BackLink } from '@/components/ui/back-link';
import { EditorHeader } from './building-editor/editor-header';
import { StepRail } from './building-editor/step-rail';
import { EditorNotices } from './building-editor/editor-notices';
import { SectorSection } from './building-editor/sector-section';
import { MapSection } from './building-editor/map-section';
import { ParcelSection } from './building-editor/parcel-section';
import { PartitionSection } from './building-editor/partition-section';
import { SharedParcelsSection } from './building-editor/shared-parcels-section';
import { FacilityFields } from './building-editor/facility-fields';
import { DuplicatesPrompt } from './building-editor/duplicates-prompt';
import { FacilityNotes } from './building-editor/facility-notes';
import { MatrixCard } from './building-editor/matrix-card';
import { SummaryCard } from './building-editor/summary-card';
import { HouseConfirm } from './building-editor/house-confirm';
import { DesktopFooter, MobileBar } from './building-editor/action-footers';
import { useBuildingFields } from './building-editor/use-building-fields';
import { useEditorDraft } from './building-editor/use-editor-draft';
import { useBuildingLoad } from './building-editor/use-building-load';
import { useParcelLookup } from './building-editor/use-parcel-lookup';
import { useStructureRules } from './building-editor/use-structure-rules';
import { useStepGates } from './building-editor/use-step-gates';
import { useBuildingSave } from './building-editor/use-building-save';

export function BuildingEditor({
  tenant,
  locale,
  adminPath,
  initialParcelNumber,
  buildingId,
  initialStep = 0,
  scope = 'all',
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  initialParcelNumber?: string;
  /**
   * The structure being corrected, or absent to create a new one.
   *
   * One wizard for both, deliberately: a correction asks exactly the questions
   * a creation does — which door, what kind of structure, how many floors,
   * which flats are inside — and a second form that asked them differently is
   * how the two drift into disagreeing about what a building is.
   */
  buildingId?: string;
  /** `?step=units` lands an officer on the matrix, which is what an empty
   *  shell's «توليد المصفوفة» is asking for. */
  initialStep?: 0 | 1 | 2;
  /**
   * How much of the building this pass is allowed to change.
   *
   * `'info'` is «تعديل معلومات المبنى»: the shell only — entrance, name, posted
   * number, type, status, notes — with no matrix step and no unit diff on save.
   * It exists because those two edits have different risks. Correcting a
   * building's name is a one-field change; the matrix carries flats with
   * occupancies, visits and server-allocated codes, and its save works by
   * diffing what is on the grid against what was loaded. Routing every small
   * shell correction through that diff makes each one a chance to remove a
   * flat by accident.
   */
  scope?: 'all' | 'info';
}) {
  const router = useRouter();
  const toast = useToast();
  const tFloors = useTranslations('floorCount');
  const en = locale === 'en';
  const tFeeExemption = useTranslations('feeExemption');
  const tEditor = useTranslations('buildingEditor');
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const tTypes = useTranslations('buildingTypes');
  const tUnitTypes = useTranslations('unitTypes');
  const editing = Boolean(buildingId);

  const { token: sessionToken, user: staffUser } = useStaffSession(tenant, base);
  const token = sessionToken ?? undefined;

  /*
    «أنواع المباني» (0106): the active list, kept on the device for a phone with no
    network; every type when editing, so a type switched off since still shows on
    the building that has it (`typesToOffer`). The structure follows the type, and
    a building with none yet shows its structure's system type.
  */
  const buildingTypes = useBuildingTypes(tenant, base, token ?? null, {
    includeInactive: editing,
    errorMessage: tTypes('loadError'),
  });
  /*
    «أنواع الوحدات» (0109), the same way: the active list, kept on the device,
    or every type when editing so a unit whose type was switched off since still
    shows its own name. Empty while it loads or offline with nothing kept — the
    grid then offers the base types, and the server files each under its system type.
  */
  const unitTypes = useUnitTypes(tenant, base, token ?? null, {
    includeInactive: editing,
    errorMessage: tUnitTypes('loadError'),
  });

  /*
    A role that cannot survey — «مشاهد فقط», an auditor, the accountant — is
    sent back to the ledger rather than shown a form every save would refuse.
    The server is the enforcement (`CENSUS_WRITE_ROLES` on every write).
  */
  useEffect(() => {
    if (staffUser && !hasRole(CENSUS_WRITE_ROLES, staffUser.role)) {
      router.replace(`${base}/buildings`);
    }
  }, [staffUser, base, router]);
  const { step, setStep, parcelNumber, setParcelNumber, zoneId, setZoneId, zones, setZones, parcelOutlines, setParcelOutlines, parcelLabelPoints, setParcelLabelPoints, zoneIndex, setZoneIndex, parcelFromMap, setParcelFromMap, isPartitioned, setIsPartitioned, partitionNumbers, setPartitionNumbers, sharedParcels, setSharedParcels, name, setName, postedNumber, setPostedNumber, structureType, setStructureType, buildingTypeId, setBuildingTypeId, offeredTypes, chosenTypeId, chosenType, chooseType, floorsCount, setFloorsCount, basementsCount, setBasementsCount, notes, setNotes, pin, setPin, pinParcelRef, gridSize, setGridSize, gridUnits, setGridUnits, baselineRef, hiddenUnits, setHiddenUnits, loadingDetail, setLoadingDetail, loadError, setLoadError, savedCode, setSavedCode, zoneCode, setZoneCode, zoneName, setZoneName, suffix, setSuffix, lifecycleStatus, setLifecycleStatus, duplicates, setDuplicates, acknowledgedDuplicates, setAcknowledgedDuplicates, duplicateReason, setDuplicateReason, noPinReason, setNoPinReason, outline, setOutline, resolvedParcel, setResolvedParcel, fallbackCentre, setFallbackCentre, outlineChecked, setOutlineChecked, cadastreHint, setCadastreHint, resolving, setResolving, saving, setSaving, inFlight, creationScope, error, setError, fieldErrors, setFieldErrors, pinError, setPinError, trimmedParcel, rootRef, headingRef, restoredRef, draftRestoredRef, draftBase, draftBaseRef, markDraftBase, staleDraft, setStaleDraft, staleDraftRef, pristineRef } = useBuildingFields({
    initialStep,
    initialParcelNumber,
    buildingTypes,
    editing,
  });

  useEditorDraft({
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
  });

  const { loadedUpdatedAtRef, loadedDetailRef, buildingReview, setBuildingReview, growthQuestion, setGrowthQuestion, houseGrowth, setHouseGrowth, loadedLifecycle, liveOccupants, previousCodes, correctingParcel, setCorrectingParcel, applyParcelCorrection, loadDetail, loadLatestVersion, keepDraftOverLatest } = useBuildingLoad({
    pinParcelRef,
    setParcelNumber,
    setSharedParcels,
    setSuffix,
    setSavedCode,
    markDraftBase,
    en,
    setHiddenUnits,
    setName,
    setPostedNumber,
    setIsPartitioned,
    setPartitionNumbers,
    setStructureType,
    setBuildingTypeId,
    setLifecycleStatus,
    setNotes,
    setPin,
    setGridUnits,
    setGridSize,
    setFloorsCount,
    setBasementsCount,
    pristineRef,
    baselineRef,
    buildingId,
    token,
    setLoadingDetail,
    setLoadError,
    tenant,
    draftRestoredRef,
    draftBaseRef,
    setStaleDraft,
    router,
    base,
    staleDraft,
    setAcknowledgedDuplicates,
    setDuplicateReason,
    setNoPinReason,
    setStep,
    initialStep,
    headingRef,
    setParcelOutlines,
    setParcelLabelPoints,
    setZones,
    setZoneIndex,
  });

  const { zoneParcelFeatures, zoneFootprint, mapParcelLabels, selectedZone, parcelZone, zoneMismatch, cleanedPartitionNumbers, cleanedSharedParcels, codePreview, applyPin, pinVerdict } = useParcelLookup({
    zoneId,
    zoneIndex,
    parcelOutlines,
    parcelLabelPoints,
    resolvedParcel,
    zones,
    trimmedParcel,
    initialParcelNumber,
    setZoneId,
    partitionNumbers,
    isPartitioned,
    sharedParcels,
    setOutline,
    setResolvedParcel,
    setFallbackCentre,
    setOutlineChecked,
    setZoneCode,
    setZoneName,
    setCadastreHint,
    setDuplicates,
    setAcknowledgedDuplicates,
    setParcelFromMap,
    setSuffix,
    setResolving,
    tenant,
    token,
    editing,
    tEditor,
    en,
    setPin,
    pinParcelRef,
    setPinError,
    zoneCode,
    suffix,
    outline,
    setParcelNumber,
    pin,
  });

  const { hasRecordedUnits, shellShortcut, warDamaged, infoOnly, skipsMatrix, lastStep, visibleSteps, promotedFromHouse, pendingUnits, setPendingUnits, requestUnits } = useStructureRules({
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
  });

  const { topGap, orphanedUnits, pinAnswered, step1Valid, step2Valid, rankedDuplicates, goToStep, goNext, goBack } = useStepGates({
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
  });

  const { handleSave, rehearseAfterAnswer } = useBuildingSave({
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
  });


  const cancelHref = `${base}/buildings`;
  /**
   * «إلغاء» is the officer saying the draft should not survive — so it is
   * cleared here and *only* here among the ways off this screen. The
   * breadcrumb is not: going to «سجل المباني» to look a code up and coming
   * back is the ordinary thing to do mid-form, and losing the work to it is
   * the bug this draft exists to prevent.
   */
  const cancelDraft = () => clearBuildingDraft(tenant, buildingId);
  const canGoNext = step === 0 ? step1Valid : step === 1 ? step2Valid : true;
  /** What the code line says: an allocated code on an edit, the provisional
   *  preview on a creation. */
  const displayCode = editing ? (savedCode ?? codePreview) : codePreview;
  const saveLabel = editing
    ? en
      ? 'Save Changes'
      : 'حفظ التعديلات'
    : shellShortcut
      ? /* «حفظ المبنى» rather than «إنشاء المبنى» on a shortened wizard: the
           officer is on step 2 of 2 and the button is where «التالي» stood a
           moment ago, so it has to read as the end of the form, not as a
           second way of starting one. */
        en
        ? 'Save Building'
        : 'حفظ المبنى'
      : en
        ? 'Create Building'
        : 'إنشاء المبنى';

  if (editing && loadingDetail) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {en ? 'Loading the building…' : 'جاري تحميل المبنى…'}
      </div>
    );
  }

  if (editing && loadError) {
    return (
      <div className="mx-auto max-w-lg space-y-3 py-20 text-center">
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadDetail()}>
            {en ? 'Retry' : 'إعادة المحاولة'}
          </Button>
          <Link href={cancelHref} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {en ? 'Building Census' : 'سجل المباني'}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8 pb-28 sm:pb-12">
      {/* At the root, not inside a step: the save can be pressed from any of them. */}
      <BuildingReviewDialog
        loaded={loadedDetailRef.current}
        review={buildingReview}
        open={buildingReview !== null}
        saving={saving}
        onCancel={() => setBuildingReview(null)}
        onConfirm={() => {
          setBuildingReview(null);
          void handleSave(true);
        }}
        locale={locale}
      />

      {/* ── Breadcrumb & Navigation ── */}
      {/*
        Wraps rather than overflows. On a phone this row can carry «رجوع», the
        section, a building code and the current step at once — more than 343px
        of gutter-less screen holds — and a breadcrumb that runs off the edge
        takes the page's horizontal scroll with it.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm text-muted-foreground">
        <BackLink fallbackHref={cancelHref} label={en ? 'Back' : 'رجوع'} />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        {/* No `cancelDraft` here — see its comment. Leaving to look a code up
            and coming back must keep the work. */}
        <Link
          href={cancelHref}
          className="transition-colors hover:text-foreground font-medium"
        >
          <span>{en ? 'Building Census' : 'سجل المباني'}</span>
        </Link>
        <ChevronRight className="size-3.5 rtl:rotate-180 text-muted-foreground/60" aria-hidden />
        {editing && buildingId ? (
          <>
            <Link
              href={`${base}/buildings/${encodeURIComponent(buildingId)}/matrix`}
              className="font-mono transition-colors hover:text-foreground"
              dir="ltr"
            >
              {savedCode ?? '—'}
            </Link>
            <ChevronRight className="size-3.5 rtl:rotate-180 text-muted-foreground/60" aria-hidden />
            <span className="text-foreground font-semibold">{en ? 'Edit' : 'تعديل'}</span>
          </>
        ) : (
          <span className="text-foreground font-semibold">{en ? 'New Building' : 'مبنى جديد'}</span>
        )}
      </div>

      {/* ── Page Header ── */}
      <EditorHeader
        headingRef={headingRef}
        editing={editing}
        en={en}
        displayCode={displayCode}
        cancelHref={cancelHref}
        cancelDraft={cancelDraft}
        step={step}
        goBack={goBack}
        lastStep={lastStep}
        goNext={goNext}
        canGoNext={canGoNext}
        handleSave={handleSave}
        saving={saving}
        staleDraft={staleDraft}
        saveLabel={saveLabel}
      />

      <StepRail
        visibleSteps={visibleSteps}
        step={step}
        editing={editing}
        goToStep={goToStep}
        en={en}
      />

      <EditorNotices
        staleDraft={staleDraft}
        staleDraftRef={staleDraftRef}
        tEditor={tEditor}
        loadLatestVersion={loadLatestVersion}
        keepDraftOverLatest={keepDraftOverLatest}
        growthQuestion={growthQuestion}
        gridUnits={gridUnits}
        en={en}
        structureType={structureType}
        saving={saving}
        locale={locale}
        rehearseAfterAnswer={rehearseAfterAnswer}
        setHouseGrowth={setHouseGrowth}
        setGrowthQuestion={setGrowthQuestion}
        error={error}
      />

      {/* ── Active Wizard Step Content ── */}
      <div className="space-y-6">
        {step === 0 ? (
          <Card className="shadow-xs border-border/80">
            <CardHeader className="border-b bg-muted/15 pb-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <MapPin className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold">
                      {en ? 'Location & Parcel' : 'الموقع والعقار'}
                    </CardTitle>

                  </div>
                </div>
                {pin ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPin(null);
                      pinParcelRef.current = null;
                      setPinError(null);
                    }}
                    className="h-8 px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    {en ? 'Clear pin' : 'حذف الدبوس'}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-5 pt-5">
              <SectorSection
                editing={editing}
                zones={zones}
                en={en}
                zoneId={zoneId}
                setZoneId={setZoneId}
              />

              <MapSection
                en={en}
                editing={editing}
                zones={zones}
                outline={outline}
                outlineChecked={outlineChecked}
                fallbackCentre={fallbackCentre}
                zoneFootprint={zoneFootprint}
                zoneParcelFeatures={zoneParcelFeatures}
                selectedZone={selectedZone}
                mapParcelLabels={mapParcelLabels}
                resolvedParcel={resolvedParcel}
                pin={pin}
                applyPin={applyPin}
                locale={locale}
                pinError={pinError}
                noPinReason={noPinReason}
                setNoPinReason={setNoPinReason}
              />

              <ParcelSection
                en={en}
                editing={editing}
                zones={zones}
                fieldErrors={fieldErrors}
                trimmedParcel={trimmedParcel}
                token={token}
                buildingId={buildingId}
                savedCode={savedCode}
                setCorrectingParcel={setCorrectingParcel}
                tenant={tenant}
                loadedUpdatedAtRef={loadedUpdatedAtRef}
                correctingParcel={correctingParcel}
                applyParcelCorrection={applyParcelCorrection}
                locale={locale}
                parcelNumber={parcelNumber}
                setParcelNumber={setParcelNumber}
                setParcelFromMap={setParcelFromMap}
                parcelFromMap={parcelFromMap}
                zoneMismatch={zoneMismatch}
                parcelZone={parcelZone}
                cadastreHint={cadastreHint}
                displayCode={displayCode}
                resolving={resolving}
                previousCodes={previousCodes}
              />

              <PartitionSection
                en={en}
                editing={editing}
                zones={zones}
                isPartitioned={isPartitioned}
                setIsPartitioned={setIsPartitioned}
                setPartitionNumbers={setPartitionNumbers}
                partitionNumbers={partitionNumbers}
              />

              <SharedParcelsSection
                en={en}
                editing={editing}
                zones={zones}
                sharedParcels={sharedParcels}
                setSharedParcels={setSharedParcels}
                trimmedParcel={trimmedParcel}
              />
            </CardContent>
          </Card>
        ) : null}

        {step === 1 ? (
          <Card className="shadow-xs border-border/80">
            <CardHeader className="border-b bg-muted/15 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-semibold">
                    {en ? 'Facility Information' : 'بيانات المنشأة'}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {en
                      ? 'Structure type, construction status, and physical attributes'
                      : 'نوع المنشأة، الحالة الإنشائية، والمواصفات الفيزيائية'}
                  </CardDescription>

                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              <FacilityFields
                tTypes={tTypes}
                fieldErrors={fieldErrors}
                offeredTypes={offeredTypes}
                chosenTypeId={chosenTypeId}
                chooseType={chooseType}
                locale={locale}
                structureType={structureType}
                setStructureType={setStructureType}
                labels={labels}
                en={en}
                lifecycleStatus={lifecycleStatus}
                setLifecycleStatus={setLifecycleStatus}
                tFeeExemption={tFeeExemption}
                editing={editing}
                liveOccupants={liveOccupants}
                loadedLifecycle={loadedLifecycle}
                hasRecordedUnits={hasRecordedUnits}
              />
              <DuplicatesPrompt
                duplicates={duplicates}
                en={en}
                trimmedParcel={trimmedParcel}
                rankedDuplicates={rankedDuplicates}
                pin={pin}
                labels={labels}
                base={base}
                cancelDraft={cancelDraft}
                acknowledgedDuplicates={acknowledgedDuplicates}
                setAcknowledgedDuplicates={setAcknowledgedDuplicates}
                duplicateReason={duplicateReason}
                setDuplicateReason={setDuplicateReason}
              />

              <FacilityNotes
                en={en}
                fieldErrors={fieldErrors}
                name={name}
                setName={setName}
                orphanedUnits={orphanedUnits}
                shellShortcut={shellShortcut}
                warDamaged={warDamaged}
                notes={notes}
                setNotes={setNotes}
              />
            </CardContent>
          </Card>
        ) : null}

        {step === 2 ? (
          <MatrixCard
            en={en}
            locale={locale}
            structureType={structureType}
            chosenType={chosenType}
            setStructureType={setStructureType}
            setBuildingTypeId={setBuildingTypeId}
            buildingTypes={buildingTypes}
            floorsCount={floorsCount}
            setFloorsCount={setFloorsCount}
            basementsCount={basementsCount}
            setBasementsCount={setBasementsCount}
            gridSize={gridSize}
            setGridSize={setGridSize}
            gridUnits={gridUnits}
            unitTypes={unitTypes}
            requestUnits={requestUnits}
            lifecycleStatus={lifecycleStatus}
            topGap={topGap}
            tFloors={tFloors}
            hiddenUnits={hiddenUnits}
          />
        ) : null}

        <SummaryCard
          step={step}
          lastStep={lastStep}
          en={en}
          codePreview={codePreview}
          trimmedParcel={trimmedParcel}
          zoneCode={zoneCode}
          zoneName={zoneName}
          tTypes={tTypes}
          chosenType={chosenType}
          locale={locale}
          labels={labels}
          structureType={structureType}
          floorsCount={floorsCount}
          basementsCount={basementsCount}
          gridUnits={gridUnits}
          hiddenUnits={hiddenUnits}
          pin={pin}
          name={name}
        />

        <HouseConfirm
          pendingUnits={pendingUnits}
          setPendingUnits={setPendingUnits}
          en={en}
          promotedFromHouse={promotedFromHouse}
          setStructureType={setStructureType}
          setGridUnits={setGridUnits}
          setGridSize={setGridSize}
          setFloorsCount={setFloorsCount}
        />
      {/* Desktop Bottom Step Navigation */}
        <DesktopFooter
          cancelHref={cancelHref}
          cancelDraft={cancelDraft}
          en={en}
          step={step}
          goBack={goBack}
          lastStep={lastStep}
          goNext={goNext}
          canGoNext={canGoNext}
          handleSave={handleSave}
          saving={saving}
          staleDraft={staleDraft}
          saveLabel={saveLabel}
        />
      </div>

      <MobileBar
        step={step}
        goBack={goBack}
        en={en}
        cancelHref={cancelHref}
        cancelDraft={cancelDraft}
        lastStep={lastStep}
        goNext={goNext}
        canGoNext={canGoNext}
        handleSave={handleSave}
        saving={saving}
        staleDraft={staleDraft}
        saveLabel={saveLabel}
      />
    </div>
  );
}

