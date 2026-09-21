'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CloudOff, UserPlus, UserRoundPen, UsersRound } from 'lucide-react';
import {
  ApiRequestError,
  createBuilding,
  createCitizen,
  duplicateReviewOf,
  getBuilding,
  getCase,
  getCitizenForm,
  getTenantConfig,
  hasDuplicateFindings,
  logApiError,
  reviewCitizenDuplicates,
  staleEditOf,
  updateCase,
  updateCitizen,
} from '@/lib/api-client';
import type { DuplicateReviewAnswer, DuplicateReviewFindings, StaleEdit } from '@/lib/api-client';
import type {
  BuildingDetail,
  CaseSummary,
  CensusSyncResult,
  CitizenFormData,
  CreateBuildingInput,
} from '@/lib/api-client';
import type {
  LandlordLinkChanges,
  LandlordLinkOffers,
  PublicTenantConfig,
} from '@/lib/api-client';
import { getOpenReturn, type OpenReturn } from '@/lib/quality-api';
import { clearSession, loadSession } from '@/lib/session';
import { formatRelative } from '@/lib/dates';
import {
  clearCitizenDraft,
  draftWorthKeeping,
  loadCitizenDraft,
  saveCitizenDraft,
} from '@/lib/citizen-draft';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import type { PropertyDraft, UnitDraft } from '@/components/citizen/property-card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LandlordLinkPrompt } from '@/components/admin/landlord-link-prompt';
import {
  DuplicateReviewDialog,
  type DuplicateReviewOutcome,
} from '@/components/admin/duplicate-review-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LoadingState } from '@/components/ui/states';
import { flagsFromArray, unverifiedFromArray } from '@/components/ui/field';
import { ShellLink, shellNavigate } from './shell-nav';
import { OfflineQueueNotice } from './offline-queue';
import { offlineStorageAvailable } from '@/lib/offline-db';
import {
  getQueuedSubmission,
  queueBuilding,
  queueSubmission,
  reviseSubmission,
  useOfflineQueue,
  useOnlineStatus,
} from '@/lib/offline-sync';
import { useToast } from '@/components/ui/toast';
import {
  CitizenForm,
  emptyCitizen,
  toSubmission,
  withResidence,
  withSeededSearch,
  type CitizenFormValues,
} from './citizen-form';
import {
  parseFloorLabel,
  POSSIBLE_DUPLICATE_FLAG_PATH,
  qualityLabels,
  STRUCTURE_TYPE_MAP,
  type CitizenResidence,
} from '@mechanization/shared-schemas';
import { mintId, type LockedCensusTarget } from './building-unit-picker';

/** `null`/`undefined` → absent; a number → the string an `<input>` holds. */
function text(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

/** The server's `landlordLink` for a card, or nothing when there is none. */
function readLandlordLink(value: unknown): PropertyDraft['landlordLink'] {
  if (!value || typeof value !== 'object') return undefined;
  const link = value as { citizenId?: unknown; name?: unknown; referenceNumber?: unknown };
  if (typeof link.citizenId !== 'string' || typeof link.name !== 'string') return undefined;
  return {
    citizenId: link.citizenId,
    name: link.name,
    referenceNumber: typeof link.referenceNumber === 'string' ? link.referenceNumber : null,
  };
}

/**
 * Tells the officer what the save did to owner links on this file.
 *
 * Each of these moved somebody else's bill — the owner's — as a consequence of
 * an edit to the tenant's record, so none of them is allowed to happen
 * silently: a card removed or a number corrected undoes its link, a corrected
 * flat moves the owner with it, and a link the card can no longer carry is
 * named with the step that fixes it.
 */
function announceLandlordLinkChanges(
  changes: LandlordLinkChanges | undefined,
  toast: ReturnType<typeof useToast>,
  locale: string,
): void {
  if (!changes) return;
  const en = locale === 'en';

  const unlinked = changes.unlinked.length;
  if (unlinked > 0) {
    const kept = changes.unlinked.some(
      (entry) => entry.report.legacy || entry.report.kept.length > 0,
    );
    toast.warning(en ? 'Owner link undone' : 'أُلغي ربط المالك', {
      description: kept
        ? en
          ? 'A card was removed or its owner’s number changed, so its link was undone. Some records on the owner’s file were kept — review them.'
          : 'حُذفت بطاقة أو تغيّر رقم مالكها فأُلغي ربطها. بقيت بعض السجلات في ملف المالك — راجعها.'
        : en
          ? 'A card was removed or its owner’s number changed, so its link was undone and what it added to the owner’s file was removed.'
          : 'حُذفت بطاقة أو تغيّر رقم مالكها فأُلغي ربطها، وأُزيل ما أضافه إلى ملف المالك.',
      duration: 10000,
    });
  }

  if (changes.reconciled && changes.reconciled.updated > 0) {
    toast.info(en ? 'Owner’s property updated' : 'تم تحديث عقار المالك', {
      description: en
        ? 'The linked owner now follows the units this card names.'
        : 'المالك المرتبط أصبح مسجَّلاً على الوحدات التي تحددها هذه البطاقة.',
    });
  }

  for (const { block } of changes.reconciled?.blocked ?? []) {
    toast.warning(en ? 'The owner link needs attention' : 'ربط المالك يحتاج مراجعة', {
      description: block.message,
      duration: 12000,
    });
  }
}

/**
 * Tells the officer what the save did to the building census.
 *
 * Registering a household into a flat now writes an occupancy, moves the unit
 * out of «غير ممسوحة» and closes any حالة waiting on that door — four rows in
 * four tables, none of which is on the screen the officer is looking at. Saying
 * nothing was the old behaviour and it was indistinguishable from the bug: the
 * link had been silently written to a column nothing read, and the only way to
 * find out was to go back to the matrix and look.
 *
 * Silent when the save touched no linked structure, which is most saves. A toast
 * that fires on every registration to report zero of everything is a toast
 * people learn to dismiss without reading.
 */
/**
 * What a passport number did to this filing — said because both outcomes that
 * are not «new» change what the officer does next.
 *
 * Filings used to *merge* on a repeated number, silently renaming whoever held
 * it. Now a same-name holder gets this registration added to their file
 * (`ATTACHED`), and a different-name holder leaves the number off a separate
 * new record for review (`CONFLICT`). Neither is an error, and neither may be
 * silent: the first means the officer is looking at an existing person's file,
 * the second that somebody's document number is wrong.
 */
function announceIdentity(
  identity: 'NEW' | 'ATTACHED' | 'CONFLICT' | null | undefined,
  toast: ReturnType<typeof useToast>,
  locale: string,
): void {
  const en = locale === 'en';
  if (identity === 'ATTACHED') {
    toast.success(
      en ? 'Added to an existing file' : 'أُضيف إلى ملف موجود',
      {
        description: en
          ? 'This passport number belongs to a citizen with the same name, so the registration was added to their file. Nothing on it was changed.'
          : 'رقم الجواز هذا لمواطن بالاسم نفسه، فأُضيف التسجيل إلى ملفه دون تغيير أي من بياناته.',
      },
    );
  } else if (identity === 'CONFLICT') {
    toast.error(
      en ? 'Passport number belongs to someone else' : 'رقم الجواز مسجَّل لشخص آخر',
      {
        description: en
          ? 'Saved as a separate person without the number, and marked for review. Check the document.'
          : 'حُفظ كشخص مستقل دون الرقم ووُضع قيد المراجعة. تحقَّق من الوثيقة.',
      },
    );
  }
}

function announceCensus(
  census: CensusSyncResult | null,
  toast: ReturnType<typeof useToast>,
  locale: string,
  deduplicated = false,
): void {
  const en = locale === 'en';

  /*
    A replay is not a failure, and it used to be reported as one.

    `CitizensService.create` skips the sync entirely for a deduplicated
    submission — deliberately, so a re-delivered record does not end and reopen
    the same occupancy or log a second visit against a door somebody stood at
    once. But it expresses "skipped" as the same `null` that means "the sync
    threw", so the ordinary offline replay — the case the queue exists for —
    told the officer the link had failed and sent them to the ledger to make it
    by hand. The link was already there. Doing as they were told creates an
    occupancy carrying no `registrationId`, which `endUnclaimed` can then never
    close: a household stays recorded in a flat their own file no longer claims,
    and keeps being billed for it.

    Nothing to announce, because nothing happened on this delivery and
    everything it would have said was said on the first one.
  */
  if (deduplicated) return;

  /*
    A failed sync is worth saying out loud, and worth saying *softly*.

    The citizen is committed — the record is safe, and telling somebody their
    registration failed when it did not is how a household ends up in the
    register twice. What they need to know is that the census link is still
    outstanding and where to finish it.
  */
  if (census === null) {
    toast.error(
      en ? 'Saved, but not linked to the census' : 'تم الحفظ دون الربط بسجل المباني',
      {
        description: en
          ? 'The record is safe. Link it to its building from the census ledger.'
          : 'السجل محفوظ. يمكن ربطه بالمبنى من سجل المباني.',
      },
    );
    return;
  }

  const linked = census.occupanciesCreated + census.occupanciesRefreshed;
  const vacanciesEnded = census.vacanciesEnded ?? 0;
  if (
    linked === 0 &&
    census.casesResolved === 0 &&
    census.buildingsNamed === 0 &&
    vacanciesEnded === 0
  ) {
    return;
  }

  const parts = [
    linked > 0
      ? en
        ? `${linked} unit(s) linked`
        : `تم ربط ${linked} وحدة`
      : null,
    census.unitsSurveyed > 0
      ? en
        ? `${census.unitsSurveyed} marked surveyed`
        : `${census.unitsSurveyed} أصبحت ممسوحة`
      : null,
    census.casesResolved > 0
      ? en
        ? `${census.casesResolved} case(s) closed`
        : `أُغلقت ${census.casesResolved} حالة`
      : null,
    census.buildingsNamed > 0
      ? en
        ? 'building name recorded'
        : 'تم تسجيل اسم المبنى'
      : null,
    /*
      Named explicitly rather than left to be noticed on the matrix. Unticking a
      flat ends a tenancy and stops it being billed, and an officer who did it
      by accident while correcting a phone number should find out now.
    */
    census.occupanciesEnded > 0
      ? en
        ? `${census.occupanciesEnded} previous unit link(s) ended`
        : `أُنهيت ${census.occupanciesEnded} صلة سابقة بوحدات`
      : null,
    /*
      Registering a household into a flat the municipality had confirmed empty
      lifts that confirmation — which starts the owner being billed for it
      again. It happened to a record nobody had open, on a screen with no unit
      matrix on it, so it is said rather than left to be discovered.
    */
    vacanciesEnded > 0
      ? en
        ? `${vacanciesEnded} confirmed vacancy(ies) lifted`
        : `أُلغي تأكيد الشغور عن ${vacanciesEnded} وحدة`
      : null,
  ].filter(Boolean);

  toast.success(en ? 'Census updated' : 'تم تحديث سجل المباني', {
    description: parts.join(en ? ' · ' : ' · '),
  });
}

/**
 * What the officer should be told before this save, if anything.
 *
 * Both cases are legitimate records and neither is refused — a card filed
 * before anyone has surveyed the parcel is the ordinary case, and a مبنى whose
 * flats are all «غير مؤكَّد» is an honest one. What neither should be is
 * silent, which is what they were: the save succeeded, the register learned
 * nothing about the census, and no screen said so.
 */
function censusConcerns(values: CitizenFormValues): string[] {
  const concerns: string[] = [];

  for (const card of values.properties) {
    if (card.propertyType !== 'BUILDING' && card.propertyType !== 'HOUSE') continue;

    const where = card.propertyNumber?.trim()
      ? `العقار ${card.propertyNumber.trim()}`
      : 'عقار بلا رقم';
    const what = card.propertyType === 'BUILDING' ? 'مبنى' : 'منزل';
    const named = card.buildingName?.trim() ? ` «${card.buildingName.trim()}»` : '';

    /*
      Nothing chosen at all. `buildingId` covers both a linked structure and a
      pending one, because the pending id *is* the row's id.
    */
    if (!card.buildingId) {
      concerns.push(`${what} · ${where}${named} — بلا ربط بسجل المباني`);
      continue;
    }

    /*
      A مبنى about to be created with no flats in it.

      `CensusSyncService` claims a unit only where the card line carries a
      `unitId`, so a shell with no units links the card and records no occupancy
      — and `heldThroughOccupancy` then bills that household for nothing. A منزل
      is exempt: it always gets exactly one unit, which the sync finds by
      `buildingId`.
    */
    if (
      card.pendingBuilding &&
      card.propertyType === 'BUILDING' &&
      !(card.units ?? []).some((unit) => unit.unitType)
    ) {
      concerns.push(`${what} · ${where}${named} — ستُنشأ المنشأة بلا وحدات`);
      continue;
    }

    /*
      A مبنى linked to a structure that already exists, with no flat ticked.

      The same silence as the case above, and the commoner one by far — it was
      only ever checked for a *pending* building, so linking to a structure the
      census already holds and then ticking nothing sailed through without a
      word. The card looks linked on screen, `buildingId` is set, and the sync
      claims nothing at all: no occupancy, no unit lifted out of «غير ممسوحة»,
      and a household that bills for nothing.

      It is emphatically not an error — a مبنى card whose flats are still being
      surveyed is honest, and this is a confirmation rather than a refusal. What
      it must not be is invisible, which is what sent somebody to the matrix to
      record the occupant by hand instead, leaving the two halves of the record
      disagreeing about the same flat.

      A منزل is exempt for the same reason as above: the sync infers its single
      unit from `buildingId`, so there is nothing to tick and nothing to warn
      about.
    */
    if (card.propertyType === 'BUILDING' && !(card.units ?? []).some((unit) => unit.unitId)) {
      concerns.push(`${what} · ${where}${named} — مرتبط بالمبنى دون تحديد أي وحدة`);
    }
  }

  return concerns;
}

/** The unit shape `POST /buildings` accepts inline, named once. */
type NewBuildingUnits = NonNullable<CreateBuildingInput['units']>;

/**
 * The units a newly created structure should be born with.
 *
 * Not an optional flourish. `CensusSyncService` claims a flat only where the
 * card line carries a `unitId`, with one exception — a منزل linked to a
 * building holding exactly one unit, which it finds by `buildingId`. So a shell
 * created with no units links the card and records no occupancy at all, and
 * `heldThroughOccupancy` then bills that household for nothing: the same silent
 * under-billing the census write path was built to fix, arriving through the
 * feature meant to complete it.
 *
 * A منزل therefore gets exactly one unit and needs no id travelling back — the
 * inference finds it. A مبنى gets one per line the officer filled in, each
 * carrying a browser-minted id that is written onto the card line, which is what
 * makes the flats claimable the moment the registration lands.
 */
function unitsForNewStructure(
  card: PropertyDraft,
  structureType: keyof typeof STRUCTURE_TYPE_MAP,
  mint: () => string,
): { units: NewBuildingUnits; lines: UnitDraft[] | undefined } {
  const defaultUnitType = STRUCTURE_TYPE_MAP[structureType].defaultUnitType;

  if (card.propertyType !== 'BUILDING') {
    return {
      units: [
        {
          floor: 0,
          unitType: defaultUnitType,
          ...(card.side ? { side: card.side } : {}),
          ...(card.unitArea ? { unitArea: Number(card.unitArea) } : {}),
        },
      ],
      lines: card.units,
    };
  }

  /*
    Only lines the officer actually filled in.

    A مبنى card starts life with one empty row, and an empty row is not a flat.
    `unitType` is the discriminator because the submission schema requires it of
    every real line — a row without one is either untouched or excused by a
    flag, and neither should mint a unit in the register.
  */
  const lines = card.units ?? [];
  const units: NewBuildingUnits = [];
  const withIds: UnitDraft[] = lines.map((line) => {
    if (!line.unitType) return line;
    const id = mint();
    units.push({
      id,
      // `parseFloorLabel` is the one-way door between the card's free text
      // («الأرضي», «ط2») and `Unit.floor`'s signed integer. An unparseable
      // label lands on the ground floor rather than refusing the whole save.
      floor: parseFloorLabel(line.floor) ?? 0,
      unitType: line.unitType,
      ...(line.side ? { side: line.side } : {}),
      ...(line.unitArea ? { unitArea: Number(line.unitArea) } : {}),
      ...(line.unitStatus ? { unitStatus: line.unitStatus } : {}),
    });
    return { ...line, unitId: id };
  });

  return { units, lines: withIds };
}

/**
 * What the census already knows about the flat the officer just tapped.
 *
 * The unit panel's «ملف جديد» link (once «تسجيل أسرة في هذه الوحدة») used to carry two UUIDs in a
 * querystring and nothing else. The form opened blank, `BuildingUnitPicker`
 * rendered nothing at all — it returns null without a رقم العقار — and an
 * officer standing in a stairwell they had already surveyed retyped the parcel
 * number, the building name, the floor and the area that the register was
 * holding two tables away.
 *
 * Everything here is a value the municipality has already recorded about the
 * structure, so seeding it is not a guess: it is the register answering a
 * question it knows the answer to. What is deliberately left blank is
 * `occupancyType` — whether this household owns or rents is exactly what the
 * officer is at the door to find out, and defaulting it would have the form
 * assert something nobody said.
 */
function censusDraft(
  building: BuildingDetail,
  unitId: string | undefined,
  locale: string,
): PropertyDraft {
  const en = locale === 'en';
  const mapped = STRUCTURE_TYPE_MAP[building.structureType];
  const unit = unitId ? building.units.find((row) => row.id === unitId) : undefined;

  /*
    A مبنى or a منزل, decided by what is standing there.

    `STRUCTURE_TYPE_MAP` is the one place that correspondence is written (D15),
    so this reads it rather than restating it — a مجمع تجاري seeds a مبنى card
    whose units are محلات, and a منزل مستقل seeds a منزل.
  */
  const propertyType = mapped.propertyType as PropertyDraft['propertyType'];

  const draft: PropertyDraft = {
    propertyType,
    propertyNumber: building.parcelNumber,
    // The register's own name for the block, not free text this officer
    // invents. Where the building has none, the field stays empty and editable
    // and whatever they type is promoted onto the building server-side.
    buildingName: building.name ?? undefined,
    /*
      Only the two card types that can carry the link.

      `branchFieldsOnly` admits `buildingId` for مبنى and منزل and drops it
      silently for anything else — so a خيمة card seeded with one would arrive
      unlinked with no complaint anywhere, which is the failure mode
      `census-link.spec.ts` exists about. A `TENT_SHELTER` structure is the one
      mapping that lands here (§3.6), and it keeps the parcel and the name
      without pretending to a link the schema will not carry.
    */
    ...(propertyType === 'BUILDING' || propertyType === 'HOUSE'
      ? { buildingId: building.id }
      : {}),
  };

  if (propertyType !== 'BUILDING') {
    /*
      A منزل carries its single unit's detail in its own columns.

      The link is the building; there is no units array to tick, and the sync
      attaches the household to the structure's one unit on the server. Copying
      the area and orientation across saves the officer measuring again.
    */
    if (unit?.side) draft.side = unit.side;
    if (unit?.unitArea != null) draft.unitArea = String(unit.unitArea);
    return draft;
  }

  /*
    A مبنى carries one card line per flat, and exactly one is seeded: the one
    that was tapped.

    Nothing is seeded when the officer came from the building rather than a
    unit. The picker's rule holds — a twelve-flat matrix says nothing about how
    many of them one person holds — and it is not violated here, because
    tapping a specific door *is* the officer saying which one.
  */
  if (unit) {
    draft.units = [
      {
        unitId: unit.id,
        unitType: unit.unitType,
        floor: floorLabel(unit.floor, en),
        side: unit.side ?? undefined,
        unitArea: unit.unitArea != null ? String(unit.unitArea) : undefined,
        unitStatus: unit.unitStatus ?? undefined,
      },
    ];
  }

  return draft;
}

/**
 * A signed floor rendered the way a person says it.
 *
 * `Unit.floor` is an integer and a card's `floor` is free text, so seeding one
 * from the other crosses that boundary. «الأرضي» rather than «0», because that
 * is what the register has always held and what the officer would have typed.
 */
function floorLabel(floor: number, en: boolean): string {
  if (floor === 0) return en ? 'Ground' : 'الأرضي';
  if (floor < 0) return en ? `Basement ${Math.abs(floor)}` : `قبو ${Math.abs(floor)}`;
  return String(floor);
}

/**
 * What a حالة already knows about the property, carried onto the first card
 * of the registration it becomes — so the officer answering the door on the
 * *second* visit does not retype رقم العقار or اسم المبنى from scratch.
 *
 * `occupancyType` is left unset on purpose: the case recorded nobody was
 * reachable, so nothing was ever established about who lives there or how.
 * That question is answered fresh, now that someone actually is home.
 */
function fromCaseDraft(item: CaseSummary): PropertyDraft {
  return {
    propertyType: item.propertyType as PropertyDraft['propertyType'],
    propertyNumber: text(item.propertyNumber),
    neighborhood: text(item.neighborhood),
    buildingName: text(item.buildingName),
    side: text(item.side),
    landType: item.landType as PropertyDraft['landType'],
    tentLocation: text(item.tentLocation),
    // BUILDING alone carries floor inside `units` — a card's own `floor` is
    // never a thing a منزل/أرض has, so the case's flat column only makes
    // sense seeded into the one unit a BUILDING card starts with.
    ...(item.propertyType === 'BUILDING' && item.floor
      ? { units: [{ floor: item.floor }] }
      : {}),
  };
}

/**
 * A stored file as the form's values — the one reading of `/citizens/:id/form`.
 *
 * Extracted from this editor's own load effect and exported rather than left
 * inline, because it is no longer the only screen that opens a record for
 * editing: `CompleteRecordDialog` fills the «يتطلب مراجعة» gaps without opening
 * the whole form, and it has to start from the *same* values or the two screens
 * disagree about what is on the record.
 *
 * Every line below is a normalisation with a reason, which is exactly why a
 * second hand-rolled copy would have been a bug rather than duplication: a
 * dialog that read `form.contact.actualHouseholdMembers` as a number would
 * render an empty box and then fail the save as «required» on a field that was
 * never blank.
 */
export function toFormValues(form: CitizenFormData): CitizenFormValues {
  return {
    residence: form.residence ?? 'RESIDENT',
    // The record's existing «غير مؤكَّد» flags, so whoever opens it to
    // finish sees which blanks were deliberate and what was said about
    // each — and clears one simply by filling the field in.
    flags: flagsFromArray(form.flags ?? []),
    /*
      The note from the last visit, restored into the box.

      A save replaces the note rather than merging it — an officer who
      clears the box means to delete it — so opening the form with an
      empty box would make every ordinary edit silently destroy what the
      previous visit wrote.
    */
    notes: form.notes ?? undefined,
    /*
      And, separately, the fields the server could not confirm against
      its cadastre.

      Kept apart from `flags` deliberately: these name fields that *have*
      a value. Folding them in would hide that value behind a reason box
      and then send it back as an officer's flag, which the server honours
      by blanking the field — the record would lose its رقم العقار as a
      side effect of someone opening it to check.
    */
    unverified: unverifiedFromArray(form.flags ?? []),
    personal: {
      ...form.personal,
      /**
       * `isLebanese` is nullable in the database — a citizen created
       * before the column existed, or by an import that skipped it —
       * and `PersonalStep` reads any non-`false` value as لبناني. Left
       * as null it renders the Lebanese branch, hides الجنسية, and then
       * fails the save on `isLebanese: null` with a message about a
       * question the form never asked. Resolving it here makes what is
       * displayed and what is sent the same answer.
       */
      isLebanese: form.personal.isLebanese !== false,
    },
    contact: {
      ...form.contact,
      // Every text input reads its value as a string; a numeric value
      // would render as an empty box and then fail validation as
      // "required" on a field that was never blank.
      actualHouseholdMembers:
        text(form.contact.actualHouseholdMembers ?? form.contact.totalRegisteredMembers) ?? '',
      totalRegisteredMembers:
        text(form.contact.totalRegisteredMembers ?? form.contact.actualHouseholdMembers) ?? '',
    },
    properties:
      form.properties.length > 0 ? form.properties.map(toDraft) : emptyCitizen().properties,
  };
}

/**
 * A stored property row as the form's draft shape.
 *
 * The inputs are all text, so every number crosses back as a string here and
 * returns coerced by `toPayloadProperty`. Nulls become `undefined` rather than
 * surviving as `null`: a controlled `<input value={null}>` is React's
 * uncontrolled-to-controlled warning, and `PROPERTY_FIELD_MAP` decides what
 * renders from presence, not from truthiness.
 */
function toDraft(property: Record<string, unknown>): PropertyDraft {
  const units = Array.isArray(property.units) ? property.units : [];

  return {
    id: text(property.id),
    /*
      The census link, read back the way it was saved.

      Dropped here until now, and the loss was double. On screen the picker had
      nothing to select from — «المنشأة في سجل المباني» reads `draft.buildingId`
      to decide which chip is chosen — so an officer opening a record that was
      linked to `C2-403-A` was shown an unlinked card and reasonably concluded
      the link had never saved. Worse, it then wasn't: `toPayloadProperty` sends
      `buildingId` only when the draft carries one, so re-saving that card wrote
      the link away, along with `Unit`'s authority over the row (P2-T8) and the
      occupancy the census had derived from it. Correcting a phone number
      unlinked a building.

      The server has always sent both halves back for exactly this reason — see
      the note beside `buildingId` in `CitizensService.form` — so nothing here
      is new information, it is simply no longer thrown away on the way in.
    */
    buildingId: text(property.buildingId),
    occupancyType: property.occupancyType as PropertyDraft['occupancyType'],
    landlordName: text(property.landlordName),
    landlordPhone: text(property.landlordPhone),
    landlordCitizenId: text(property.landlordCitizenId),
    /*
      The standing link, so the card opens locked to it — number and name — with
      «إلغاء الربط» as the way out. Without it an edit showed the tenant's typed
      name in an unlocked box over a link the server was still holding.
    */
    landlordLink: readLandlordLink(property.landlordLink),
    propertyType: property.propertyType as PropertyDraft['propertyType'],
    neighborhood: text(property.neighborhood),
    propertyNumber: text(property.propertyNumber),
    landType: property.landType as PropertyDraft['landType'],
    buildingName: text(property.buildingName),
    side: text(property.side),
    tentLocation: text(property.tentLocation),
    unitArea: text(property.unitArea),
    shares: text(property.shares),
    sharedRights: (property.sharedRights as string[] | null) ?? [],
    // Not routed through `text()`: this is an enum the choice control compares
    // by identity, and null must stay absent rather than become the empty
    // string — «not recorded» is a state the control renders, and one that
    // means something different from any of its four options.
    unitStatus: (property.unitStatus ?? undefined) as PropertyDraft['unitStatus'],
    // Only a building carries units; leaving an empty array on the others
    // would make `PropertyCard` render a units editor the schema rejects.
    ...(units.length > 0
      ? {
          units: units.map(
            (unit): UnitDraft => ({
              // The stored row itself, so the save keeps it by identity and can
              // refuse it if its flat ended while this form was open.
              id: text((unit as Record<string, unknown>).id),
              // The per-flat half of the same link: which canonical `Unit` this
              // line is about. Without it the matrix chips come back unticked
              // and a re-save orphans every row that named a surveyed flat.
              unitId: text((unit as Record<string, unknown>).unitId),
              unitType: (unit as Record<string, unknown>).unitType as UnitDraft['unitType'],
              floor: text((unit as Record<string, unknown>).floor),
              side: text((unit as Record<string, unknown>).side),
              unitArea: text((unit as Record<string, unknown>).unitArea),
              sharedRights:
                ((unit as Record<string, unknown>).sharedRights as string[] | null) ?? [],
              unitStatus: ((unit as Record<string, unknown>).unitStatus ??
                undefined) as UnitDraft['unitStatus'],
            }),
          ),
        }
      : {}),
  };
}

/**
 * Create or correct one citizen, on a page of its own.
 *
 * A page rather than a modal: this form is the wizard's three data steps at
 * full size, with a repeatable property card that carries its own repeatable
 * unit editor inside it. A household with a four-unit building is several
 * screens tall, and a dialog that scrolls internally would put the clerk's
 * «حفظ» and the field they are typing in two different scroll contexts.
 */
export function CitizenEditor({
  tenant,
  locale,
  adminPath,
  /** Absent = creating. */
  citizenId,
  /**
   * The id of a record still sitting in this device's offline queue —
   * present only on `citizens/queue/[queueId]`, and mutually exclusive with
   * `citizenId`: a queued record has no server citizen to be an id for yet.
   */
  queueId,
  /**
   * Arrived from the "Register Citizen" action on an open حالة. Seeds the
   * first property card from what that visit recorded, and — once this
   * registration is actually saved online — resolves the case back to
   * whoever gets created here. See `fromCaseDraft` and `submit` below.
   */
  fromCaseId,
  lockedCensusTarget,
  initialResidence,
  initialSearch,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  citizenId?: string;
  queueId?: string;
  fromCaseId?: string;
  /**
   * نوع الملف already answered by the link that opened this form — the unit
   * panel's «مالك غير مقيم» choice. Applied to a new record only; a saved or
   * queued one keeps what it was saved as.
   */
  initialResidence?: CitizenResidence;
  /**
   * The search term that sent the officer here — the occupant panel's own box,
   * carried across so a search that found nobody is not retyped.
   *
   * Applied to a new record only: to the phone field when it is a number, to
   * the name when it is a name, and to neither otherwise (`withSeededSearch`).
   * Its real job is to give the duplicate check something to check on the
   * very first render.
   */
  initialSearch?: string;
  /**
   * Arrived from a building's unit matrix — the structure, and possibly the
   * flat, is already decided.
   *
   * A URL parameter rather than shared state, for the same reason `fromCaseId`
   * is one: the matrix lives on another route, and the two screens should not
   * have to know about each other beyond a link.
   */
  lockedCensusTarget?: LockedCensusTarget | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const editing = citizenId !== undefined;
  const isQueuedEdit = queueId !== undefined;

  const online = useOnlineStatus();
  // Mounting this is also what starts the sync engine and drains any backlog,
  // so an officer who opens the entry form after regaining signal has their
  // queue delivered without having to go looking for a button.
  const queue = useOfflineQueue(tenant);

  /**
   * Offline entry is for *new* records only — never a correction to a citizen
   * already on the server.
   *
   * A correction is a read-modify-write against a row this device may hold a
   * stale copy of — queued for hours and replayed later, it would silently
   * overwrite whatever a colleague changed in the meantime. Registering
   * someone new has no such conflict: the record does not exist yet, and the
   * `clientSubmissionId` covers the only race that remains. So an edit made
   * with no connection fails honestly and is retried by a person.
   *
   * Correcting a *queued* record is a third thing entirely, and excluded here
   * for the opposite reason: it always writes back to the queue, connection or
   * not, so it has no need of the network-first/fallback dance this decides.
   */
  const canQueue = !editing && !isQueuedEdit && offlineStorageAvailable();
  const willQueue = canQueue && !online;

  const [token, setToken] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicTenantConfig | null>(null);
  const [initial, setInitial] = useState<CitizenFormValues | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * A save held while the officer reads what it will and will not record.
   *
   * Holds the exact values that were validated, so confirming saves what was
   * checked rather than whatever the form has become in the meantime.
   */
  const [pendingSave, setPendingSave] = useState<{
    values: CitizenFormValues;
    concerns: string[];
  } | null>(null);
  /**
   * Owner links the save turned up, and where the officer was going next.
   *
   * The route change is held rather than the save — the record is committed by
   * the time this is set. Keeping the destination here rather than recomputing
   * it on close means a create and an edit leave by exactly the path they
   * already decided on, including the citizen id a create only learns from its
   * own response.
   */
  const [linkOffers, setLinkOffers] = useState<{
    offers: LandlordLinkOffers;
    next: string;
  } | null>(null);
  /**
   * A save held on «هل هو مسجَّل مسبقاً؟ / لمن هذا الرقم؟».
   *
   * Holds the validated values, exactly as `pendingSave` does, so answering
   * saves what was checked rather than whatever the form has become.
   */
  const [duplicateReview, setDuplicateReview] = useState<{
    values: CitizenFormValues;
    findings: DuplicateReviewFindings;
  } | null>(null);
  /**
   * On an edit of a record held at «سجل مشابه موجود»: the officer's statement
   * that the match is a different person, sent with the next save.
   */
  const [duplicateCleared, setDuplicateCleared] = useState(false);
  const [duplicateClearedReason, setDuplicateClearedReason] = useState('');
  /**
   * The reviewer's own words, when this record was sent back for correction.
   *
   * Read-only here: saving the record is what closes the return, so the officer
   * fixes what the sentence names and presses «حفظ» as usual. Quiet on failure —
   * an unreachable quality endpoint must not stop somebody editing a citizen.
   */
  const [openReturn, setOpenReturn] = useState<OpenReturn | null>(null);
  /**
   * The version of the file this form was opened at. A ref, not state: the
   * «احفظ على أي حال» answer moves it and saves in the same tick, and a
   * `useCallback` closing over state would still send the old one.
   */
  const fileVersionRef = useRef<string | null>(null);
  /** Who last changed this file, when the server said. */
  const [lastStaffEdit, setLastStaffEdit] = useState<CitizenFormData['lastStaffEdit']>(null);
  /** A save refused because somebody changed the file after it was opened. */
  const [staleSave, setStaleSave] = useState<{ values: CitizenFormValues; stale: StaleEdit } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * When the restored draft was last written, or `null` if this is a fresh
   * form. Drives the notice above the form — a form that silently arrives
   * pre-filled is indistinguishable from one showing somebody else's record.
   */
  const [restoredAt, setRestoredAt] = useState<Date | null>(null);

  /**
   * Whether this screen keeps a draft at all.
   *
   * Creating only, and the reasoning is `canQueue`'s: a draft of a correction
   * to a server record is a stale read-modify-write waiting to overwrite a
   * colleague, while a draft of a new registration has nothing to conflict
   * with. A queued record is excluded for the opposite reason — it is already
   * durable in IndexedDB, so a second copy in localStorage would be two
   * answers to "what did they type" with no rule for which wins.
   */
  const keepsDraft = !editing && !isQueuedEdit;

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    // Read-only roles are bounced rather than shown a form every save would
    // refuse. The server is the enforcement; this keeps it out of their way.
    if (
      session.user.role !== 'SUPER_ADMIN' &&
      session.user.role !== 'FIELD_INSPECTOR' &&
      session.user.role !== 'ADMINISTRATIVE_OFFICER'
    ) {
      router.replace(`${base}/citizens`);
      return;
    }
    setToken(session.accessToken);
  }, [tenant, base, router]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      try {
        // The tenant config decides which أنواع العقارات this municipality
        // accepts, so the form cannot offer one that would be refused on save.
        // `getQueuedSubmission` touches only IndexedDB, not the network — it
        // runs alongside the other two rather than blocking on them.
        const [tenantConfig, form, queued, fromCase, censusBuilding] = await Promise.all([
          getTenantConfig(tenant),
          citizenId ? getCitizenForm(tenant, token, citizenId) : Promise.resolve(null),
          queueId ? getQueuedSubmission(tenant, queueId) : Promise.resolve(null),
          fromCaseId ? getCase(tenant, token, fromCaseId).catch(() => null) : Promise.resolve(null),
          /*
            The structure behind `?buildingId=`, fetched so the first card can
            be seeded from it.

            Swallowed on failure, exactly as the case lookup beside it is: an
            officer who tapped a flat and lost signal on the way to this screen
            still needs a working registration form. They get a blank one and
            the link is made later, which is worse than the prefill and far
            better than a page that will not open.
          */
          lockedCensusTarget
            ? getBuilding(tenant, token, lockedCensusTarget.buildingId).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;

        setConfig(tenantConfig);

        if (queueId) {
          if (!queued) {
            // Synced by another tab, or discarded, in the time between the
            // link being shown and being followed. Not an error to alarm
            // over — the record reaching the municipality is the outcome
            // this whole feature wants.
            setLoadError(
              locale === 'en'
                ? 'This record is no longer in the queue — it may have already been sent.'
                : 'هذا السجل لم يعد في قائمة الانتظار — ربما أُرسل بالفعل.',
            );
            return;
          }

          setInitial({
            residence: queued.payload.residence ?? 'RESIDENT',
            personal: queued.payload.personal,
            contact: queued.payload.contact,
            properties:
              queued.payload.properties.length > 0
                ? queued.payload.properties.map(toDraft)
                : emptyCitizen().properties,
            flags: flagsFromArray(queued.payload.flags),
            // A queued record has never reached the server, so nothing has had
            // the cadastre to check it against yet.
            unverified: new Map(),
            // Whatever the officer typed before the phone lost signal.
            notes: queued.payload.notes,
          });

          // Shown as though it were the result of this visit's own attempt —
          // which it is: it is why this record needed opening at all, and
          // repeating it here saves a trip back to the queue panel to recall.
          if (queued.lastError) setError(queued.lastError);
          return;
        }

        if (!form) {
          const empty = emptyCitizen();

          /*
            Three ways in, and they cannot both seed the first card.

            The census target wins where both are present, and that ordering is
            not arbitrary: a حالة carries what an officer wrote from the
            doorstep — free text, possibly «الطابق الثاني» with four flats on
            it — while the census carries rows the municipality created and
            numbered. Where the two describe the same place, the numbered one is
            the better answer, and the case is still resolved by the
            registration either way.
          */
          const seeded = censusBuilding
            ? [censusDraft(censusBuilding, lockedCensusTarget?.unitId, locale)]
            : fromCase
              ? [fromCaseDraft(fromCase)]
              : null;

          /*
            Four ways in now, and the saved draft is the one that yields.

            A draft is what this officer was typing *last* time. A census
            target or a حالة is what they asked for *this* time, in the URL
            they just followed — the unit panel's «ملف جديد» link names a specific
            flat, and restoring yesterday's half-finished household over it
            would answer a deliberate request with a stale one, in a form
            already carrying a locked building the draft knows nothing about.

            So the draft is restored only on a plain arrival at the blank form,
            which is every arrival from the sidebar. It is not discarded in the
            other cases — nothing here writes — so following a unit link and
            then coming back to «تسجيل مواطن جديد» still finds it.
          */
          if (!seeded && !initialResidence && !initialSearch) {
            const draft = loadCitizenDraft(tenant);
            if (draft) {
              setInitial(draft.values);
              setRestoredAt(draft.savedAt);
              return;
            }
          }

          const fresh = seeded ? { ...empty, properties: seeded } : empty;
          const withFile = initialResidence ? withResidence(fresh, initialResidence) : fresh;
          setInitial(initialSearch ? withSeededSearch(withFile, initialSearch) : withFile);
          return;
        }

        setReference(form.referenceNumber);
        fileVersionRef.current = form.version ?? null;
        setLastStaffEdit(form.lastStaffEdit ?? null);
        setInitial(toFormValues(form));
      } catch (caught) {
        if (cancelled) return;
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        if (!citizenId && !queueId) {
          // Creating a new citizen should never be blocked by network failure
          setConfig({
            slug: tenant,
            name: tenant,
            nameAr: tenant,
            enabledPropertyTypes: ['BUILDING', 'HOUSE', 'LAND', 'TENT'],
            requiredDocuments: [],
            branding: {},
          });
          setInitial(emptyCitizen());
          return;
        }
        setLoadError(
          caught instanceof ApiRequestError && caught.status === 404
            ? (locale === 'en' ? 'No citizen found with this ID.' : 'لا يوجد مواطن بهذا المعرّف.')
            : (locale === 'en' ? 'Failed to load citizen data.' : 'تعذّر تحميل بيانات المواطن.'),
        );
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    /*
      `lockedCensusTarget` is deliberately not a dependency.

      It is an object literal rebuilt from the querystring on every render of
      the page above, so listing it would re-run this whole load — including the
      building fetch — on every keystroke in the form. Its two fields are plain
      strings that cannot change without a navigation, and a navigation remounts
      this component, so the effect already re-runs exactly when it should.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tenant,
    token,
    citizenId,
    queueId,
    fromCaseId,
    initialResidence,
    initialSearch,
    base,
    router,
    locale,
  ]);

  /**
   * Creates every «منشأة جديدة» the officer chose, and rewrites the cards.
   *
   * Returns the form values with each `pendingBuilding` discharged: the card
   * keeps the `buildingId` it already had — the browser minted it, and
   * `clientSubmissionId` makes it the row's primary key — and its unit lines
   * gain the `unitId`s that make them claimable.
   *
   * Offline it queues instead of posting. The id is the same either way, which
   * is the whole reason the queue mints ids at all: buildings drain before
   * registrations, so by the time the registration is delivered the row it
   * names exists. `acknowledgedDuplicates` is carried from the officer's own
   * tap rather than defaulted — the picker refuses to offer this branch
   * without one whenever the answer might be "there is already a structure
   * here", including when the census could not be reached to ask.
   */
  const materialiseBuildings = useCallback(
    async (values: CitizenFormValues): Promise<CitizenFormValues> => {
      const properties = [...values.properties];

      for (let index = 0; index < properties.length; index += 1) {
        const card = properties[index]!;
        const pendingBuilding = card.pendingBuilding;
        if (!pendingBuilding) continue;

        const { units, lines } = unitsForNewStructure(card, pendingBuilding.structureType, mintId);

        const input = {
          parcelNumber: pendingBuilding.parcelNumber,
          structureType: pendingBuilding.structureType,
          clientSubmissionId: pendingBuilding.id,
          ...(pendingBuilding.acknowledgedDuplicates ? { acknowledgedDuplicates: true } : {}),
          /*
            No `latitude`/`longitude`, and no `name`.

            The pin because a guess in the column that means "the entrance" is
            indistinguishable from a surveyed fact, identical for every
            structure on the parcel, and points at the middle of a plot where
            no building stands (D19). The name because the card's «اسم المبنى»
            is still being typed: `CensusSyncService` promotes it onto the
            building after the registration commits, and sending it here would
            lock the field read-only mid-keystroke.
          */
          ...(units.length > 0 ? { units } : {}),
        };

        if (willQueue) {
          await queueBuilding({
            id: pendingBuilding.id,
            tenant,
            parcelNumber: pendingBuilding.parcelNumber,
            /*
              There is no code to show yet and none is invented. The editor's
              own offline path can preview one because it has the parcel's
              sector and taken suffixes in hand; this path has neither, and a
              made-up code on a queue notice is worse than the parcel number.
            */
            provisionalCode: pendingBuilding.parcelNumber,
            provisionalSuffix: '',
            payload: {
              parcelNumber: pendingBuilding.parcelNumber,
              structureType: pendingBuilding.structureType,
              /*
                The officer's own answer, not a blanket `true`.

                This was hardcoded, on the reasoning that a person had been
                asked before it was queued. They had — but on a parcel the
                census confirmed empty the question put to them was "create one
                here", not "this is not one of the structures already here", and
                there were none to be shown. Sending `true` there pre-satisfies
                D18's guard for a delivery that may land hours later on a parcel
                somebody else has since built on, with nobody at the screen.

                Where the officer *was* shown neighbours, or was told the census
                could not be reached, the flag is genuinely theirs and travels.
              */
              ...(pendingBuilding.acknowledgedDuplicates
                ? { acknowledgedDuplicates: true }
                : {}),
              ...(units.length > 0 ? { units } : {}),
            },
            blueprint: null,
          });
        } else {
          if (!token) throw new Error('no session');
          await createBuilding(tenant, token, input);
        }

        properties[index] = { ...card, pendingBuilding: undefined, units: lines };
      }

      return { ...values, properties };
    },
    [tenant, token, willQueue],
  );

  /*
    Autosave, debounced, and cancelled on unmount by the timer it owns.

    Half a second rather than every keystroke because each write is a
    synchronous `JSON.stringify` of the whole form plus a localStorage put, and
    doing that inside the keystroke handler of a long Arabic text field is felt
    on the low-end phones this is used on. Half a second is also short enough
    that the realistic way to lose work — clicking a sidebar link — always
    lands after the write.

    `draftWorthKeeping` gates the write rather than the read: an officer who
    opens the form, looks at it and leaves must not create a draft, or the next
    arrival is met by «استُعيدت مسودة» over a form identical to a blank one.
  */
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );

  const rememberDraft = useCallback(
    (values: CitizenFormValues) => {
      if (!keepsDraft) return;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        if (draftWorthKeeping(values)) saveCitizenDraft(tenant, values);
        else clearCitizenDraft(tenant);
      }, 500);
    },
    [keepsDraft, tenant],
  );

  /**
   * Drops the draft and stops the pending write that would put it back.
   *
   * The second half is not optional. «حفظ» and «إلغاء» are both reachable
   * within the debounce window of the last keystroke, so clearing storage
   * without cancelling the timer leaves a scheduled callback that re-saves the
   * form half a second after the officer asked to be rid of it — and the next
   * arrival is offered a draft of a household that has already been filed.
   */
  const forgetDraft = useCallback(() => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (keepsDraft) clearCitizenDraft(tenant);
  }, [keepsDraft, tenant]);

  const submit = useCallback(
    async (
      values: CitizenFormValues,
      confirmed = false,
      /**
       * The officer's answer to the duplicate question. `null` means it was
       * asked and needed no answer (the phone was cleared instead), so the
       * pre-check is not run a second time for the same values.
       */
      duplicateAnswer?: DuplicateReviewAnswer | null,
    ) => {
      if (!token) return;

      /*
        Two things worth saying before a save that cannot be taken back easily.

        Neither is a refusal — both describe legitimate records — but both used
        to happen in complete silence, and silence is what made them defects
        rather than choices. A third of the cards in the first municipality to
        use this are linked to nothing, and no screen anywhere says so.
      */
      if (!confirmed) {
        const concerns = censusConcerns(values);
        if (concerns.length > 0) {
          setPendingSave({ values, concerns });
          return;
        }
      }

      setSubmitting(true);
      setError(null);

      /*
        «هل هو مسجَّل مسبقاً؟» — asked before anything is written.

        Only for a brand-new registration going straight to the server. Before
        the structures below are materialised, so a household that turns out to
        be somebody already on file leaves no empty building behind. If this
        lookup fails the save goes on: the server asks the same question on
        `createCitizen` (`reviewDuplicates`), so a skipped check here is not a
        skipped check.
      */
      if (!citizenId && !queueId && !willQueue && duplicateAnswer === undefined) {
        try {
          const findings = await reviewCitizenDuplicates(tenant, token, toSubmission(values));
          if (hasDuplicateFindings(findings)) {
            setDuplicateReview({ values, findings });
            setSubmitting(false);
            return;
          }
        } catch (caught) {
          logApiError(caught);
        }
      }

      /*
        `toSubmission`, not a second hand-built copy of it.

        This used to assemble the four sections itself, and it silently dropped
        the one field it did not know about: `blanketFlagReason`. «حفظ سريع»
        put the officer's reason on `values`, the form validated a submission
        that carried it — `validate()` parses `toSubmission(values)` — and then
        this object went to the wire without it, on both the online save and the
        queued one. P2-T7's `autoFlags` never fired, so the gaps the reason was
        written to excuse either failed validation server-side or saved without
        the record landing at «يتطلب مراجعة».

        One builder for the payload the form validates and the payload the
        server receives is the only arrangement where that class of bug cannot
        come back.
      */
      /*
        The structures the officer asked for, created before the registration
        that names them.

        Before this, and never after. A card carrying a `buildingId` for a
        building that does not exist is a link to nothing: `CensusSyncService`
        would read it, find no unit, and record no occupancy — while the officer
        was told the registration saved, which it did.

        Deliberately *not* inside `CensusSyncService`. That method is
        contractually forbidden from throwing (a census hiccup must never cost a
        municipality a registration), so a building created there would vanish
        on failure with nothing said; and `importMany` runs it once per row, so
        a five-hundred-row CSV import would mint five hundred structures
        unattended. Here, a failure is in front of the person who asked for it,
        at the moment they can answer.
      */
      let materialised = values;
      if (values.properties.some((card) => card.pendingBuilding)) {
        try {
          materialised = await materialiseBuildings(values);
        } catch (caught) {
          logApiError(caught);
          setError(
            caught instanceof ApiRequestError
              ? caught.payload.message
              : locale === 'en'
                ? 'Could not create the new structure. The registration was not saved.'
                : 'تعذّر إنشاء المنشأة الجديدة. لم يُحفظ السجل.',
          );
          setSubmitting(false);
          return;
        }
      }

      const payload = toSubmission(materialised);

      const displayName =
        [values.personal.firstName, values.personal.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() || (locale === 'en' ? 'Unnamed record' : 'سجل بلا اسم');

      /*
        Correcting a record that is already sitting in the queue.

        Never touches the network directly — `reviseSubmission` overwrites the
        local copy and hands the drain a corrected record to try, whether that
        happens in the next second (a connection is here right now, which is
        usually why the record was opened) or the next time signal returns
        (still offline, but the fix is no longer at risk of being lost to a
        connection nobody controls).
      */
      if (queueId) {
        try {
          const found = await reviseSubmission(tenant, queueId, payload, displayName);
          toast.success(
            found
              ? locale === 'en'
                ? 'Updated — this record will be sent automatically.'
                : 'تم التحديث — سيُعاد إرسال السجل تلقائياً.'
              : locale === 'en'
                ? 'This record had already been sent — there was nothing left to update.'
                : 'كان هذا السجل قد أُرسل بالفعل — لا حاجة لتحديثه.',
          );
          shellNavigate(router, `${base}/citizens`);
        } catch (caught) {
          logApiError(caught);
          setError(
            locale === 'en'
              ? 'Could not update the record stored on this device.'
              : 'تعذّر تحديث السجل المحفوظ على هذا الجهاز.',
          );
          setSubmitting(false);
        }
        return;
      }

      /*
        No connection: the record is stored on this device and the officer
        moves on to the next household.

        The id is minted here, before anything is sent, and travels with every
        later retry as `clientSubmissionId` — which is what makes a lost
        response harmless. The form validates against the shared schema, though
        server-only invariants (duplicate identity document, tenant property
        type policy) can still hold it for review or rejection upon sync.
      */
      if (willQueue) {
        try {
          await queueSubmission({ tenant, displayName, payload });

          // Stored durably in IndexedDB now, so the localStorage draft has
          // nothing left to protect — and leaving it would offer the next
          // arrival a copy of a household already waiting to be sent.
          forgetDraft();

          toast.success(
            locale === 'en'
              ? 'Saved on this device — it will sync automatically when you are back online.'
              : 'حُفظ على هذا الجهاز — سيُرسل تلقائياً عند عودة الاتصال.',
          );
          shellNavigate(router, `${base}/citizens`);
          return;
        } catch (caught) {
          // IndexedDB refused — a private window, a full disk, the store held
          // open by another tab mid-upgrade. Said plainly, because the officer
          // is about to walk away from a record that was not stored.
          logApiError(caught);
          setError(
            locale === 'en'
              ? 'This device could not store the record. Do not close this page — try again once you have a connection.'
              : 'تعذّر حفظ السجل على هذا الجهاز. لا تُغلق الصفحة — أعد المحاولة عند توفّر الاتصال.',
          );
          setSubmitting(false);
          return;
        }
      }

      /*
        Navigation, or the owner question first.

        A save that turned up a possible owner link holds the route change and
        puts the question while the officer is still here — see
        `LandlordLinkPrompt` for why now is the only cheap moment to ask it.
        The record is already committed either way; what is deferred is the
        push, and the dialog performs it on close.

        `setSubmitting(false)` deliberately does not run in the held case. The
        form underneath is finished and about to be left, and re-enabling its
        save button behind a modal is an invitation to file the household twice.
      */
      /*
        Where the officer actually wanted to end up.

        An officer who arrived through a unit panel's «ملف جديد» link was sent here
        *by a flat*, and their next move is invariably that same flat — check
        the occupancy landed, register the neighbour, log the next visit. The
        form dropped them on the new citizen's file instead, so every household
        cost a trip back to the ledger, a search for the building, and a hunt
        through the matrix for the unit they had just been standing in.

        Everything the census sync wrote is on the page they came from, which
        is also the screen that can *show* it — the citizen's own file cannot
        say whether the unit left «غير ممسوحة». So the return is to that same
        building's unit matrix.
      */
      const destination = lockedCensusTarget
        ? `${base}/buildings/${encodeURIComponent(lockedCensusTarget.buildingId)}/matrix`
        : null;

      const leave = (offers: LandlordLinkOffers | null, href: string) => {
        const next = destination ?? href;
        const pending = (offers?.filed.length ?? 0) + (offers?.naming.length ?? 0);
        if (pending > 0 && offers) {
          setLinkOffers({ offers, next });
          return;
        }
        router.push(next);
      };

      try {
        if (citizenId) {
          const updated = await updateCitizen(tenant, token, citizenId, {
            ...payload,
            ...(fileVersionRef.current ? { expectedVersion: fileVersionRef.current } : {}),
            ...(duplicateCleared && duplicateClearedReason.trim().length >= 4
              ? {
                  duplicateReview: {
                    differentFrom: [],
                    sharedPhoneWith: [],
                    sharedPhoneWithLandlord: false,
                    reason: duplicateClearedReason.trim(),
                  },
                }
              : {}),
          });
          announceCensus(updated.census, toast, locale);
          announceLandlordLinkChanges(updated.landlordLinkChanges, toast, locale);
          leave(updated.landlordLinks, `${base}/citizens/${citizenId}`);
        } else {
          /*
            `reviewDuplicates` is added here, at the call, and never to
            `payload`: the same object is queued below if the request never
            arrives, and a queued delivery must not be refused hours later with
            nobody at the screen to answer.
          */
          const created = await createCitizen(tenant, token, {
            ...payload,
            reviewDuplicates: true,
            ...(duplicateAnswer ? { duplicateReview: duplicateAnswer } : {}),
          });
          announceCensus(created.census, toast, locale, created.deduplicated);
          announceIdentity(created.identity, toast, locale);

          // The household is on the server. Cleared here rather than after the
          // case-linking below, which is allowed to fail without the
          // registration being in any doubt.
          forgetDraft();

          /*
            The other half of the bridge. Only reachable here — a citizen
            actually exists to link now — which is also why the offline and
            queued branches above return before ever reaching this point: a
            case cannot be resolved to a citizen that has not been created
            yet, and there is no network here to ask the server to do it
            regardless. Left unlinked in that case, but not unlinkable — the
            Cases screen's own "Link to Citizen" search reaches the same
            citizen once this record has synced.
          */
          if (fromCaseId) {
            try {
              await updateCase(tenant, token, fromCaseId, { resolvedCitizenId: created.citizenId });
              toast.success(
                locale === 'en' ? 'Case resolved' : 'تم حل الحالة',
                {
                  description:
                    locale === 'en'
                      ? 'This registration has been linked back to the case that led to it.'
                      : 'تم ربط هذا التسجيل بالحالة التي أدّت إليه.',
                },
              );
            } catch (caseError) {
              // The registration itself succeeded — that is what matters — so
              // a failure here is surfaced softly rather than blocking the
              // navigation below or looking like the save itself failed.
              logApiError(caseError);
              toast.error(
                locale === 'en' ? 'Could not resolve the case' : 'تعذّر حل الحالة',
                {
                  description:
                    locale === 'en'
                      ? 'The citizen was registered. Link the case to them from the Cases screen.'
                      : 'تم تسجيل المواطن. اربط الحالة به من شاشة الحالات.',
                },
              );
            }
          }

          leave(created.landlordLinks, `${base}/citizens/${created.citizenId}`);
        }
        router.refresh();
      } catch (caught) {
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }

        /*
          The server asked the question the pre-check did not — somebody was
          registered in between, or the pre-check could not reach it. Put to the
          officer exactly as the pre-check would have.
        */
        const findings = !citizenId ? duplicateReviewOf(caught) : null;
        if (findings) {
          setDuplicateReview({ values, findings });
          setSubmitting(false);
          return;
        }

        // Somebody saved this file after it was opened — ask before replacing.
        const stale = citizenId ? staleEditOf(caught) : null;
        if (stale) {
          setStaleSave({ values, stale });
          setSubmitting(false);
          return;
        }

        /*
          The request left and never arrived — `navigator.onLine` said yes, and
          it was wrong.

          It is wrong often: a captive portal, a dead uplink, a phone showing
          bars in a valley. That is precisely the moment this record is most
          likely to be lost, and the officer has already typed it, so it is
          queued rather than handed back as an error to retype. Only a
          brand-new registration takes this path, for the reason `canQueue`
          explains.
        */
        if (canQueue && caught instanceof ApiRequestError && caught.status === 0) {
          try {
            await queueSubmission({ tenant, displayName, payload });

            toast.success(
              locale === 'en'
                ? 'Connection lost — saved on this device and queued for sync.'
                : 'انقطع الاتصال — حُفظ السجل على الجهاز وسيُرسل تلقائياً.',
            );
            shellNavigate(router, `${base}/citizens`);
            return;
          } catch (queueFailure) {
            logApiError(queueFailure);
          }
        }

        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : (locale === 'en' ? 'Failed to save data. Please try again.' : 'تعذّر حفظ البيانات. حاول مرة أخرى.'),
        );
        setSubmitting(false);
      }
    },
    [
      tenant,
      token,
      citizenId,
      queueId,
      fromCaseId,
      lockedCensusTarget,
      base,
      router,
      locale,
      willQueue,
      canQueue,
      toast,
      materialiseBuildings,
      forgetDraft,
      duplicateCleared,
      duplicateClearedReason,
    ],
  );

  /**
   * The officer answered the duplicate question. A cleared phone becomes an
   * ordinary «غير مؤكَّد» flag on the form's own values, so it is validated and
   * stored exactly as if they had flagged the field by hand.
   */
  const resolveDuplicateReview = useCallback(
    (outcome: DuplicateReviewOutcome) => {
      const held = duplicateReview;
      setDuplicateReview(null);
      if (!held) return;

      if (!outcome.clear.phone && !outcome.clear.whatsapp) {
        void submit(held.values, true, outcome.answer ?? null);
        return;
      }

      /*
        Each number cleared on its own. The phone takes a WhatsApp number that
        was the same number with it; a WhatsApp number of its own stays unless
        it too was somebody else's.
      */
      let contact = { ...held.values.contact };
      const flags = new Map(held.values.flags);
      if (outcome.clear.phone) {
        const whatsappIsPhone =
          contact.whatsappSameAsPhone !== false || contact.whatsapp === contact.phone;
        flags.set('contact.phone', outcome.clear.phone);
        contact = {
          ...contact,
          phone: '',
          ...(whatsappIsPhone ? { whatsapp: '', whatsappSameAsPhone: true } : {}),
        };
      }
      if (outcome.clear.whatsapp) {
        flags.set('contact.whatsapp', outcome.clear.whatsapp);
        contact = { ...contact, whatsapp: '', whatsappSameAsPhone: false };
      }
      void submit({ ...held.values, contact, flags }, true, outcome.answer ?? null);
    },
    [duplicateReview, submit],
  );

  useEffect(() => {
    if (!citizenId || !token) return;
    let cancelled = false;
    getOpenReturn(tenant, token, citizenId)
      .then((result) => {
        if (!cancelled) setOpenReturn(result.openReturn);
      })
      .catch((caught) => logApiError(caught));
    return () => {
      cancelled = true;
    };
  }, [tenant, token, citizenId]);

  /**
   * Somebody else changed this file within the last hour. Said when the form
   * opens, because on 2026-09-16 two officers spent 45 minutes saving over each
   * other on one registration and neither screen said so.
   */
  const recentOtherEdit =
    citizenId &&
    lastStaffEdit &&
    !lastStaffEdit.byViewer &&
    Date.now() - new Date(lastStaffEdit.at).getTime() < 60 * 60 * 1000
      ? lastStaffEdit
      : null;

  /** The server's «سجل مشابه موجود» note on the record being edited, if one stands. */
  const standingDuplicateNote =
    citizenId && initial ? (initial.unverified.get(POSSIBLE_DUPLICATE_FLAG_PATH) ?? null) : null;

  const cancelHref = useMemo(
    () => (citizenId ? `${base}/citizens/${citizenId}` : `${base}/citizens`),
    [base, citizenId],
  );

  if (!token) return null;

  if (loadError) {
    return (
      <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {loadError}
        </p>
        <ShellLink href={`${base}/citizens`} className={buttonVariants({ variant: 'outline' })}>
          {locale === 'en' ? 'Back to Citizens Registry' : 'رجوع إلى سجل المواطنين'}
        </ShellLink>
      </div>
    );
  }

  if (!config || !initial) {
    return (
      <LoadingState fullHeight />
    );
  }

  const Icon = isQueuedEdit ? CloudOff : editing ? UserRoundPen : UserPlus;

  return (
    <div className="w-full space-y-3.5 sm:space-y-6 px-3 py-3 sm:px-6 sm:py-6 lg:px-8 pb-20 sm:pb-8">
      <ShellLink
        href={cancelHref}
        className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-3.5 sm:size-4 rtl:rotate-180" aria-hidden />
        {editing
          ? (locale === 'en' ? 'Back to Citizen Profile' : 'رجوع إلى ملف المواطن')
          : (locale === 'en' ? 'Back to Citizens Registry' : 'رجوع إلى سجل المواطنين')}
      </ShellLink>

      <div className="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3 border-b pb-3 sm:pb-4">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <span
            aria-hidden
            className="flex size-8 sm:size-10 shrink-0 items-center justify-center rounded-lg sm:rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20"
          >
            <Icon className="size-4 sm:size-5" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <h1 className="truncate text-base sm:text-2xl font-bold tracking-tight text-foreground">
              {isQueuedEdit
                ? (locale === 'en' ? 'Correct Unsent Record' : 'تصحيح سجل غير مُرسَل')
                : editing
                  ? (locale === 'en' ? 'Edit Citizen Information' : 'تعديل بيانات مواطن')
                  : (locale === 'en' ? 'Register New Citizen' : 'تسجيل مواطن جديد')}
            </h1>
            <p className="text-[11px] sm:text-xs text-muted-foreground hidden sm:block">
              {isQueuedEdit
                ? (locale === 'en'
                    ? 'This record is stored only on this device and has not reached the municipality. Saving here updates the local copy and retries sending it automatically.'
                    : 'هذا السجل محفوظ على هذا الجهاز فقط ولم يصل إلى البلدية بعد. الحفظ هنا يُحدّث النسخة المحلية ويعيد محاولة إرسالها تلقائياً.')
                : editing
                  ? (locale === 'en'
                      ? "Edits apply to this citizen's latest application. Prior submissions are preserved in their history."
                      : 'التعديلات تُطبَّق على أحدث طلب لهذا المواطن. الطلبات السابقة تبقى كما هي في ملفه.')
                  : (locale === 'en'
                      ? 'The application is registered with status "Pending" and appears in the verification queue.'
                      : 'يُسجَّل الطلب بحالة «قيد الانتظار» ويظهر في قائمة المراجعة كأي طلب آخر.')}
            </p>
          </div>
        </div>

        {reference ? (
          <Badge variant="outline" className="font-mono text-xs" dir="ltr">
            {reference}
          </Badge>
        ) : null}
      </div>

      {/*
        Says the form did not arrive blank, and offers the way out.

        A pre-filled form with no explanation is the worst version of this
        feature: it looks like somebody else's record, and an officer who does
        not trust it clears twenty fields by hand. Naming when it was typed is
        what makes it recognisable as their own — «منذ قليل» for the trip to the
        registry they just made, a date for the draft they abandoned yesterday.

        «ابدأ نموذجاً فارغاً» is the discard, and it is here rather than only on
        «إلغاء» because the two are different intentions: cancel leaves the
        screen, this stays on it and starts over.
      */}
      {restoredAt ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-4 py-3">
          <p className="text-xs text-foreground/80">
            {locale === 'en'
              ? `Restored an unsaved draft (${formatRelative(restoredAt, locale)}). Continue where you left off, or start over.`
              : `تمت استعادة مسودة غير محفوظة (${formatRelative(restoredAt, locale)}). يمكنك المتابعة من حيث توقفت أو البدء من جديد.`}
          </p>
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            onClick={() => {
              forgetDraft();
              setRestoredAt(null);
              // A fresh object identity, which is what `CitizenForm`'s
              // re-seeding effect keys on — handing back the same `initial`
              // would leave every field exactly as it was.
              setInitial(emptyCitizen());
            }}
          >
            {locale === 'en' ? 'Start a blank form' : 'ابدأ نموذجاً فارغاً'}
          </button>
        </div>
      ) : null}

      {queue.pending > 0 || queue.blocked > 0 ? (
        <OfflineQueueNotice
          pending={queue.pending}
          blocked={queue.blocked}
          syncing={queue.syncing}
          authRequired={queue.authRequired}
          onSync={queue.sync}
          locale={locale}
          href={`${base}/citizens`}
        />
      ) : null}

      {openReturn ? (
        <div className="space-y-2 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-semibold text-warning">
            <ArrowRight className="size-4 shrink-0 rtl:rotate-180" aria-hidden />
            {locale === 'en' ? 'Sent back for correction' : 'أُعيد هذا السجل للتصحيح'}
          </p>
          {openReturn.reason ? <p className="leading-relaxed">{openReturn.reason}</p> : null}
          {openReturn.fields.length > 0 ? (
            <p className="flex flex-wrap gap-1">
              {openReturn.fields.map((field) => (
                <Badge key={field} variant="soft-warning" className="text-[10px]">
                  {qualityLabels(locale).reviewField[field] ?? field}
                </Badge>
              ))}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {locale === 'en'
              ? `${openReturn.by ?? 'A reviewer'} · ${formatRelative(new Date(openReturn.at), locale)} — saving this record marks it corrected.`
              : `${openReturn.by ?? 'المراجع'} · ${formatRelative(new Date(openReturn.at), locale)} — حفظ السجل يسجّله مُصحَّحاً.`}
          </p>
        </div>
      ) : null}

      {recentOtherEdit ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <UserRoundPen className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>
            {locale === 'en'
              ? `${recentOtherEdit.name ?? 'Another member of staff'} changed this file ${formatRelative(new Date(recentOtherEdit.at), locale)}. Make sure you are not both working on it — the later save will be asked before it replaces the earlier one.`
              : `عدّل ${recentOtherEdit.name ?? 'موظف آخر'} هذا الملف ${formatRelative(new Date(recentOtherEdit.at), locale)}. تأكَّد أنكما لا تعملان عليه معاً — سيُسأل الحفظ اللاحق قبل أن يستبدل السابق.`}
          </p>
        </div>
      ) : null}

      {standingDuplicateNote ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-semibold text-warning">
            <UsersRound className="size-4 shrink-0" aria-hidden />
            {locale === 'en' ? 'Possible existing record' : 'سجل مشابه موجود'}
          </p>
          <p className="text-muted-foreground">{standingDuplicateNote}</p>
          <p className="text-xs text-muted-foreground">
            {locale === 'en'
              ? 'Search for the reference above. If it is the same person, do not save here — ask an administrator to merge the two files. If it is a different person, say so below and save.'
              : 'ابحث عن الرقم المرجعي أعلاه. إن كان الشخص نفسه فلا تحفظ هنا — اطلب من الإدارة دمج الملفين. وإن كان شخصاً مختلفاً فاذكر ذلك أدناه واحفظ.'}
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <Checkbox
              checked={duplicateCleared}
              onCheckedChange={(checked) => setDuplicateCleared(checked === true)}
              className="mt-0.5"
            />
            <span className="font-medium">
              {locale === 'en'
                ? 'I checked: this is a different person'
                : 'تحقَّقت: هذا شخص مختلف'}
            </span>
          </label>
          {duplicateCleared ? (
            <div className="space-y-1">
              <Label htmlFor="duplicate-cleared-reason" className="text-xs">
                {locale === 'en' ? 'How do you know?' : 'كيف عرفت ذلك؟'}
              </Label>
              <Textarea
                id="duplicate-cleared-reason"
                value={duplicateClearedReason}
                onChange={(event) => setDuplicateClearedReason(event.target.value)}
                maxLength={300}
                className="min-h-[56px] text-sm"
              />
              {duplicateClearedReason.trim().length < 4 ? (
                <p className="text-[11px] text-muted-foreground">
                  {locale === 'en'
                    ? 'Without a reason the note stays on the record after saving.'
                    : 'بدون سبب يبقى التنبيه على السجل بعد الحفظ.'}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <CitizenForm
        tenant={tenant}
        token={token}
        citizenId={citizenId}
        config={config}
        mode={editing || isQueuedEdit ? 'edit' : 'create'}
        initial={initial}
        submitting={submitting}
        error={error}
        // A queued-edit always writes back to the queue, whatever the current
        // connection is — the "will this be sent or stored?" framing belongs
        // to a brand-new record's very first save, not to correcting one
        // that already lives on this device either way.
        offline={isQueuedEdit ? false : willQueue}
        onSubmit={(values) => void submit(values)}
        onCancel={() => {
          // «إلغاء» is the officer saying the draft should not survive —
          // the one exit from this form that means that. Navigating away by
          // any other route deliberately keeps it.
          forgetDraft();
          shellNavigate(router, cancelHref);
        }}
        onValuesChange={rememberDraft}
        locale={locale}
        lockedCensusTarget={lockedCensusTarget}
      />

      {/*
        Not destructive, and not a refusal.

        Every case it names is a record the municipality is entitled to keep —
        a card on a parcel nobody has surveyed, a مبنى whose flats are all still
        «غير مؤكَّد». The dialog exists because these used to happen in silence:
        the officer saved, the register learned nothing about the census, and no
        screen said so. `destructive={false}` because the confirm button is the
        ordinary way through, not the dangerous one.
      */}
      <ConfirmDialog
        open={pendingSave !== null}
        onOpenChange={(next) => {
          if (!next) setPendingSave(null);
        }}
        destructive={false}
        title={
          locale === 'en'
            ? 'Save without linking to the census?'
            : 'الحفظ دون استكمال الربط بسجل المباني؟'
        }
        description={
          <span className="block space-y-2">
            <span className="block">
              {locale === 'en'
                ? 'The record will be saved. These cards will record no occupancy and will not appear on the map as their own structure:'
                : 'سيُحفظ السجل. هذه البطاقات لن تُسجّل إشغالاً ولن تظهر على الخريطة كمنشأة خاصة بها:'}
            </span>
            <span className="block space-y-1">
              {(pendingSave?.concerns ?? []).map((line) => (
                <span key={line} className="block text-foreground">
                  • {line}
                </span>
              ))}
            </span>
            <span className="block">
              {locale === 'en'
                ? 'This is allowed — the link can be made later from the census ledger.'
                : 'هذا مسموح — يمكن إتمام الربط لاحقاً من سجل المباني.'}
            </span>
          </span>
        }
        confirmLabel={locale === 'en' ? 'Save anyway' : 'متابعة بدون ربط'}
        cancelLabel={locale === 'en' ? 'Go back and link' : 'رجوع والربط'}
        onConfirm={async () => {
          const held = pendingSave;
          setPendingSave(null);
          if (held) await submit(held.values, true);
        }}
      />

      {/*
        The owner question, after a save that turned one up.

        Rendered here rather than on the destination page because the officer
        who typed the number is the person who can answer it — the file they
        land on next belongs to the household, not to the claim. The push it is
        holding runs on close, whichever way the question was answered or left.
      */}
      <ConfirmDialog
        open={staleSave !== null}
        onOpenChange={(next) => {
          if (!next) setStaleSave(null);
        }}
        destructive
        title={
          locale === 'en'
            ? 'This file changed after you opened it'
            : 'عُدِّل هذا الملف بعد أن فتحتَه'
        }
        description={
          staleSave
            ? locale === 'en'
              ? `${staleSave.stale.byViewer ? 'You' : (staleSave.stale.lastEditedBy ?? 'Someone')} saved it${staleSave.stale.lastEditedAt ? ` ${formatRelative(new Date(staleSave.stale.lastEditedAt), locale)}` : ''}. Saving now replaces those changes with what is on your screen. To see their changes instead, go back and reload the page — what you typed here will be lost.`
              : `حفظه ${staleSave.stale.byViewer ? 'أنت' : (staleSave.stale.lastEditedBy ?? 'موظف آخر')}${staleSave.stale.lastEditedAt ? ` ${formatRelative(new Date(staleSave.stale.lastEditedAt), locale)}` : ''}. الحفظ الآن يستبدل تلك التعديلات بما على شاشتك. ولرؤية تعديلاته بدلاً من ذلك ارجع وحدِّث الصفحة — وسيضيع ما كتبته هنا.`
            : ''
        }
        confirmLabel={locale === 'en' ? 'Save and replace' : 'احفظ واستبدل'}
        cancelLabel={locale === 'en' ? 'Back, without saving' : 'رجوع دون حفظ'}
        onConfirm={async () => {
          const held = staleSave;
          setStaleSave(null);
          if (!held) return;
          fileVersionRef.current = held.stale.version;
          await submit(held.values, true, null);
        }}
      />

      {duplicateReview ? (
        <DuplicateReviewDialog
          findings={duplicateReview.findings}
          numbers={{
            phone:
              typeof duplicateReview.values.contact.phone === 'string'
                ? duplicateReview.values.contact.phone
                : null,
            whatsapp:
              duplicateReview.values.contact.whatsappSameAsPhone === false &&
              typeof duplicateReview.values.contact.whatsapp === 'string'
                ? duplicateReview.values.contact.whatsapp
                : null,
          }}
          citizenHref={(id) => `${base}/citizens/${encodeURIComponent(id)}`}
          locale={locale}
          onCancel={() => setDuplicateReview(null)}
          onResolve={resolveDuplicateReview}
        />
      ) : null}

      {linkOffers ? (
        <LandlordLinkPrompt
          tenant={tenant}
          token={token}
          offers={linkOffers.offers}
          citizenHref={(id) => `${base}/citizens/${id}`}
          onClose={() => {
            const next = linkOffers.next;
            setLinkOffers(null);
            router.push(next);
            router.refresh();
          }}
          locale={locale}
        />
      ) : null}
    </div>
  );
}
