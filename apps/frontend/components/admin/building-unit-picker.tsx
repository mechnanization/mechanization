'use client';

import { useEffect, useMemo, useState } from 'react';
import { Building2, Check, Link2, Loader2, Lock, Plus, TriangleAlert, Unlink } from 'lucide-react';
import {
  getLabels,
  STRUCTURE_TYPE,
  defaultUnitTypeFor,
  STRUCTURE_TYPE_MAP,
  structureTypeForProperty,
  type StructureType,
  type UnitStatus,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import {
  addUnit,
  ApiRequestError,
  duplicateUnitsOf,
  getBuildingCached,
  getParcelBuildings,
  logApiError,
  peekBuilding,
  peekParcelBuildings,
  type BuildingDetail,
  type BuildingLedgerRow,
  type DuplicateUnitCandidate,
  type UnitWithOccupants,
} from '@/lib/api-client';
import type { PropertyDraft, UnitDraft } from '@/components/citizen/property-card';
import {
  cellBadge,
  floorLabel,
  groupUnitsByFloor,
  layoutFloor,
  withDeclaredBasements,
} from '@/components/admin/building-unit-forms';
import { UnitHoldingsGrid } from '@/components/admin/unit-holdings-grid';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  BUILDING_UNIT_TYPES,
  type CensusUnitFacts,
} from '@/components/citizen/unit-fields';

/**
 * A client-minted id that will be the row's primary key.
 *
 * The same trick the offline queue plays for a building created in airplane
 * mode: `clientSubmissionId` is stored *as* `Building.id`, so a form can name
 * the structure before it has been sent, and a re-delivery is recognised rather
 * than making a second one.
 */
export function mintId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Older WebViews and non-secure contexts have no randomUUID.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Ties one property card to the censused structure it is about (P3-T6).
 *
 * This is the link §3.7 exists for and P2-T8 turns on: where a card line names
 * a canonical `Unit`, that `Unit` is authoritative field by field, and the flat
 * the citizen filed and the flat the municipality surveyed are known to be the
 * same flat rather than two rows that happen to agree.
 *
 * Two things it deliberately does *not* do:
 *
 *  - **It never invents a building.** If the parcel has no censused structure
 *    the control says so and stays out of the way — a card filed before anyone
 *    surveyed the parcel is the normal case, not an error, and forcing a link
 *    would mean an officer creating a shell from the registration form with
 *    none of the information the census needs.
 *  - **It never picks units on the citizen's behalf.** A twelve-flat matrix
 *    says nothing about whether this person holds one of them or twelve; that
 *    is exactly the mistake P2-T8's first attempt made. The officer ticks the
 *    ones this citizen holds, and nothing is ticked by default.
 */

/** What the picker was launched with, when it came from a matrix. */
export interface LockedCensusTarget {
  buildingId: string;
  /** Set when the officer tapped a specific flat rather than the building. */
  unitId?: string;
}

/**
 * The structure a card is linked to, reported up so the card can state what the
 * register already knows instead of asking for it again.
 *
 * The rule this type exists to serve, and the reason every field is nullable:
 * **a field is locked if and only if the census holds a value for it.** That is
 * the rule «اسم المبنى» has always followed — an unnamed building leaves the
 * field open, because the officer in its stairwell is the person who learns the
 * name and `CensusSyncService` promotes what they type upward. Generalising it
 * is what stops a lock from making a fact unrecordable by the only person
 * standing where it can be established.
 */
export interface LinkedBuildingFacts {
  id: string;
  code: string;
  name: string | null;
  /**
   * The parcel this structure stands on — the register's own answer, which the
   * card's رقم العقار is mirrored from and locked to.
   *
   * Without it the card could claim one عقار while `buildingId` pointed at a
   * building standing on another, and nothing anywhere reconciled the two:
   * `applyOccupancy` guards unit↔building, and nothing guarded card↔building.
   */
  parcelNumber: string;
  /** The matrix, so the card can name a linked unit and state what it holds. */
  units: CensusUnitFacts[];
}

export function BuildingUnitPicker({
  tenant,
  token,
  draft,
  citizenId,
  onChange,
  onLinkedBuilding,
  locked,
  onMatrixState,
  aside,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  draft: PropertyDraft;
  /**
   * The citizen whose card this is, when the register already has an id for
   * them — absent on a create, where nobody has been saved yet.
   *
   * Only the unit chips read it, and only to answer "is this spell theirs or
   * somebody else's". Without it the control could see *that* a flat had an
   * occupant and never *whose*, so it warned an owner about his own recorded
   * occupancy in exactly the same words it used for a tenant living in his
   * flat. Absent, every spell reads as somebody else's — which is the safe
   * direction on a create, because a citizen who does not exist yet cannot be
   * the person already in the flat.
   */
  citizenId?: string;
  /**
   * An updater, matching `PropertyCard`'s own.
   *
   * This control writes from several independent effects — the locked target,
   * the building-name mirror, the unit matrix — which routinely land in the
   * same commit. A patch built from the `draft` prop would therefore be built
   * from a snapshot one of its siblings had already superseded, and `units`
   * especially is computed *from* the previous array rather than replacing it
   * wholesale. See `PropertyCard.onChange`.
   */
  onChange: (update: (current: PropertyDraft) => PropertyDraft) => void;
  /**
   * The structure this card now points at, or null when it points at none.
   *
   * Reported upward rather than kept here because «اسم المبنى» is rendered by
   * the card, and it needs to know whether the register already has a name for
   * the block — a linked, named building makes that field a statement rather
   * than a question. The alternative was the card fetching the same building a
   * second time, which is how two components start disagreeing about it.
   */
  onLinkedBuilding?: (building: LinkedBuildingFacts | null) => void;
  /**
   * Launched from the matrix: the building — and possibly the unit — is not a
   * choice. Shown as a statement with the reason, rather than a disabled
   * select, because a control that cannot be used is a question that should
   * not have been asked.
   */
  locked?: LockedCensusTarget | null;
  /**
   * Whether the locked matrix is showing this citizen's flats, and which one
   * is tapped. The card follows it: nothing below the matrix until a flat is
   * chosen, then that flat's own fields directly under it.
   */
  onMatrixState?: (state: { active: boolean; unitId: string | null }) => void;
  /**
   * The card's «من سجل المباني» box, set beside this control's own head — the
   * two say what the card is linked to, one as facts and one as the choice,
   * so they sit as one row. The flats follow underneath, full width.
   */
  aside?: React.ReactNode;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const parcelNumber = draft.propertyNumber?.trim() ?? '';
  const isBuilding = draft.propertyType === 'BUILDING';

  /*
    Seeded from what this tab has already read, not from empty.

    The control re-mounts constantly — one per property card, again on every
    unfold, again each time the edit form is opened — and every mount used to
    start at `[]`/`'idle'` and announce «جاري مراجعة سجل المباني…» while it
    re-asked a question already answered. Even with the read cached the answer
    arrives a microtask later, and that is still one rendered frame of the
    message — long enough to read as the choice being thrown away and made
    again, which is exactly how officers described it.

    Lazy initialisers, so the peek happens once on mount. A *changed* parcel is
    the effect's business below.
  */
  const [candidates, setCandidates] = useState<BuildingLedgerRow[]>(
    () => (parcelNumber ? peekParcelBuildings(tenant, parcelNumber)?.buildings : undefined) ?? [],
  );
  /*
    Three answers, not two.

    This used to be a boolean beside a list that a failed lookup emptied, so
    «لا توجد منشأة مسجَّلة على هذا العقار» was printed whether the census said
    that or could not be reached at all — and offline, which is where this form
    is mostly used, it could never say anything else. Harmless while the control
    only offered a link. Not harmless now that it can *create* one: an empty
    list is the state in which creating is safe, and treating an unreachable
    census as an empty one would mint a structure on every field registration.
  */
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'ok' | 'failed'>(() =>
    parcelNumber && peekParcelBuildings(tenant, parcelNumber) ? 'ok' : 'idle',
  );
  const loading = lookup === 'loading';
  const [detail, setDetail] = useState<BuildingDetail | null>(
    () => (draft.buildingId ? peekBuilding(tenant, draft.buildingId) : undefined) ?? null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  /**
   * The officer said «بدون ربط» for this parcel.
   *
   * Needed because "no link" and "not yet decided" are the same absence in the
   * draft — `buildingId` is undefined for both — and a preselect that could not
   * tell them apart would re-arm itself the instant somebody declined it.
   * Parcel-scoped: a different عقار is a different question.
   */
  const [declined, setDeclined] = useState(false);

  /**
   * Bumped to re-read the chosen building's matrix after adding a flat to it.
   *
   * The alternative — splicing the created unit into `detail` by hand — keeps
   * two copies of the matrix in step only for as long as nobody changes what a
   * unit row contains. Re-reading is one request on an action an officer takes
   * rarely, and it also picks up `unitCode`, which the *server* derives from
   * floor and sequence and the client must never guess.
   */
  const [matrixVersion, setMatrixVersion] = useState(0);
  /** The «إضافة وحدة» sub-form: closed, or open and holding a floor and a type. */
  const [adding, setAdding] = useState<{ floor: string; unitType: string } | null>(null);
  /**
   * Where the open sub-form is drawn — a floor's own container, or under the
   * matrix.
   *
   * Kept beside the floor it was opened *at* rather than derived from the floor
   * it currently holds, so correcting the floor number in the form does not
   * make the form itself jump between containers as it is typed into.
   */
  const [addingAnchor, setAddingAnchor] = useState<number | 'bottom' | null>(null);
  const [addingBusy, setAddingBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  /**
   * The units the server held out when «إضافة وحدة» hit its duplicate guard.
   *
   * Null is "not asked"; a list is "asked, awaiting the answer". Kept beside
   * `adding` rather than inside it because the sub-form's own state is what the
   * officer typed, and this is what the register replied — clearing one must
   * not clear the other, or declining the prompt would throw away the floor and
   * type they had just entered.
   */
  const [duplicateUnits, setDuplicateUnits] = useState<DuplicateUnitCandidate[] | null>(null);

  // ── Which structures stand on this parcel ─────────────────────────
  useEffect(() => {
    // A different عقار is a different question, so any earlier «بدون ربط»
    // stops applying the moment the parcel changes.
    setDeclined(false);

    /*
      A structure armed for the previous parcel follows the card to this one.

      `pendingBuilding.parcelNumber` is what `dischargePending` actually sends
      — the card's own رقم العقار is never consulted — so an officer who armed
      «منشأة جديدة» on 1042 and then corrected the number to 998 created the
      building on 1042 and filed the citizen on 998. Both rows valid, pointing
      at different parcels, with nothing comparing them.

      Re-pointed rather than cleared, so the structure type they chose survives
      a typo correction. `acknowledgedDuplicates` does not survive it: that was
      a person saying «تحقَّقت، وهذه منشأة مختلفة» about what stands on the
      *old* parcel, and carrying it over would pre-answer the duplicate guard
      for a parcel nobody has looked at. Cleared, the guard asks again.
    */
    if (parcelNumber) {
      onChange((current) =>
        current.pendingBuilding && current.pendingBuilding.parcelNumber !== parcelNumber
          ? {
              ...current,
              pendingBuilding: {
                ...current.pendingBuilding,
                parcelNumber,
                acknowledgedDuplicates: false,
              },
            }
          : current,
      );
    }

    if (!parcelNumber) {
      setCandidates([]);
      setLookup('idle');
      return;
    }
    /*
      A card arriving from the matrix has its parcel already, because the editor
      seeds it from the building. This lookup is still what populates the *other*
      structures on that parcel, which is what the officer needs in order to
      notice they are on the wrong one.
    */
    let cancelled = false;
    /*
      A parcel this tab has already read is answered before the request is even
      issued — `getParcelBuildings` hands back exactly this value, so all
      `'loading'` would add is the spinner frame.
    */
    const known = peekParcelBuildings(tenant, parcelNumber);
    if (known) {
      setCandidates(known.buildings);
      setLookup('ok');
    } else {
      setLookup('loading');
    }

    getParcelBuildings(tenant, token, parcelNumber)
      .then((response) => {
        if (cancelled) return;
        setCandidates(response.buildings);
        setLookup('ok');
      })
      .catch((caught) => {
        // A census the officer cannot reach must not block a registration: the
        // link is an enrichment, and the card is valid without it. But the
        // control has to *say* it could not reach it — see `lookup` above.
        logApiError(caught);
        if (cancelled) return;
        setCandidates([]);
        setLookup('failed');
      });

    return () => {
      cancelled = true;
    };
    // `onChange` is a fresh closure each render, and this effect must fire on a
    // *changed parcel* only — depending on it would re-run the lookup, and the
    // pending re-point, on every keystroke elsewhere in the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, token, parcelNumber]);

  // ── The chosen structure's matrix ─────────────────────────────────
  const buildingId = draft.buildingId ?? null;

  useEffect(() => {
    /*
      A pending building has no row to fetch.

      Its id is minted in the browser and only becomes a row when the
      registration is saved, so asking for it is a guaranteed 404 — swallowed,
      but it left `detail` null and the muted «لا توجد منشأة مسجَّلة على هذا
      العقار بعد» rendered directly above the panel announcing that one is about
      to be created.
    */
    if (!buildingId || buildingId === draft.pendingBuilding?.id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    /*
      The matrix, when this tab already holds it — same reasoning as the parcel
      listing above. Freshness is not lost by it: every census write drops the
      entry, so the `matrixVersion` bump after «إضافة وحدة» still reaches the
      network.
    */
    const known = peekBuilding(tenant, buildingId);
    if (known) setDetail(known);
    setDetailLoading(!known);

    getBuildingCached(tenant, token, buildingId)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((caught) => {
        logApiError(caught);
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, buildingId, draft.pendingBuilding?.id, matrixVersion]);

  /*
    A locked target is applied once, and only onto a card that has not already
    been pointed somewhere else. Re-applying it on every render would fight an
    officer who deliberately unlinked, which is a legitimate correction.
  */
  useEffect(() => {
    if (!locked || draft.buildingId) return;
    onChange((current) => ({ ...current, buildingId: locked.buildingId }));
    // `onChange` is a fresh closure each render; depending on it would re-run
    // this on every keystroke elsewhere in the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, draft.buildingId]);

  /*
    Tell the card which structure it is on, and keep the two names in step.

    The parcel and the register are the two halves of an address, and they used
    to be able to disagree without either screen noticing: the card's
    «اسم المبنى» was free text, `Building.name` was the register's own, and
    nothing compared them. Linked to a *named* building, the register's answer
    is copied down and the input is locked — a change made once on the building
    then shows on every card in it.

    An *unnamed* building is left alone in both directions. The officer in its
    stairwell may be the person who learns the name, so their typing is kept and
    promoted onto the building server-side (`CensusSyncService`). Copying an
    empty name down would erase what they had already typed.
  */
  /*
    Reported alongside the building: what the matrix calls each flat.

    «وحدات المبنى» renders the unit rows, including the ones created by ticking
    a chip up here — and without this it could only head them «الوحدة ١», a
    number that means nothing to somebody who chose `0202` from the matrix. The
    card holds no copy of the matrix and must not fetch a second one, so the
    control that already has it says so.

    Keyed on a flat signature rather than on `detail.units` itself: the array is
    a new object on every fetch, and depending on it would re-report — and
    re-render the card — on each one.
  */
  /*
    Widened beyond `unitCode` when the card started *locking* against these
    values rather than merely labelling rows with them. A signature that only
    covered the code would hold a stale area on screen — read-only, and
    therefore uncorrectable — after somebody fixed it on the building itself.
    Every field the card can lock has to be able to invalidate this.
  */
  const unitSignature = (detail?.units ?? [])
    .map((unit) =>
      [unit.id, unit.unitCode, unit.unitType, unit.floor, unit.side ?? '', unit.unitArea ?? ''].join(
        ':',
      ),
    )
    .join(',');

  useEffect(() => {
    if (!onLinkedBuilding) return;
    onLinkedBuilding(
      detail
        ? {
            id: detail.id,
            code: detail.code,
            name: detail.name,
            parcelNumber: detail.parcelNumber,
            units: detail.units.map((unit) => ({
              id: unit.id,
              unitCode: unit.unitCode,
              unitType: unit.unitType,
              floor: floorText(unit.floor, en),
              side: unit.side,
              unitArea: unit.unitArea != null ? String(unit.unitArea) : null,
            })),
          }
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.code, detail?.name, detail?.parcelNumber, unitSignature, en]);

  useEffect(() => {
    const name = detail?.name?.trim();
    if (!name || draft.buildingName === name) return;
    onChange((current) => ({ ...current, buildingName: name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.name, draft.buildingName]);

  /*
    The same mirror for رقم العقار, and this one closes a silent corruption
    rather than a spelling disagreement.

    «اسم المبنى» was locked to the register and the parcel was not, so an
    officer on a linked card could edit the عقار freely — and the card then
    claimed parcel 1042 while `buildingId` pointed at a building standing on
    998. Nothing anywhere reconciled the two: `applyOccupancy` checks that a
    unit belongs to the building the card names, and no check at all compared
    the card's parcel against that building's. The record was internally
    inconsistent, validated cleanly, and billed.

    Copied down unconditionally, unlike the name: a building always has a
    parcel, so there is no "the register has no answer yet" case to leave open.
    It converges — the write only fires while the two disagree — and it also
    repairs a record that was saved mismatched before the field was locked,
    the first time anybody opens it.

    A *pending* structure is deliberately not mirrored. It has no parcel of its
    own yet; it takes the card's. See the re-point in the parcel effect above.
  */
  /*
    A card on one of the building's *shared* parcels is already consistent, and
    is left alone. A structure filed under 10 that also covers 25 is the building
    a household on 25 lives in, and 25 is the number on their deed — rewriting
    it to 10 would put the building's filing number on somebody's title in
    place of their own. Only a parcel the building does not stand on at all is
    corrected, which is the corruption the mirror exists for.
  */
  const sharedParcelKey = (detail?.sharedParcelNumbers ?? []).join(',');
  useEffect(() => {
    const parcel = detail?.parcelNumber?.trim();
    const onCard = draft.propertyNumber?.trim();
    if (!parcel || onCard === parcel) return;
    if (onCard && (detail?.sharedParcelNumbers ?? []).includes(onCard)) return;
    onChange((current) => ({ ...current, propertyNumber: parcel }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.parcelNumber, sharedParcelKey, draft.propertyNumber]);

  const linkedUnitIds = useMemo(
    () => new Set((draft.units ?? []).map((unit) => unit.unitId).filter(Boolean) as string[]),
    [draft.units],
  );

  /**
   * The matrix drawn the way the building sheet draws it — floors top-down,
   * each one's units in the order they run along it.
   *
   * A flat list was wrong on exactly the buildings this control matters on: a
   * block with shops on the ground floor and flats above it wrapped into one
   * run of chips, and «0001» beside «0301» said nothing about which of them was
   * the shop the officer was standing in.
   */
  const floors = useMemo(
    () =>
      withDeclaredBasements(
        groupUnitsByFloor(detail?.units ?? []),
        detail?.basementsCount,
      ),
    [detail],
  );


  const [editingLinks] = useState(
    () => !(draft.units ?? []).some((unit) => unit.unitId),
  );
  const [shownUnitId, setShownUnitId] = useState<string | null>(null);
  const gridFloors = useMemo(
    () => floors.map(({ floor, units }) => ({ floor, ...layoutFloor(units) })),
    [floors],
  );
  /*
    Active only while there is something of theirs to tap. A card whose matrix
    lights nothing, or that is choosing its flats, is not driven by it — there
    would be no flat to open and no way to release what it held back.
  */
  const matrixActive =
    Boolean(buildingId) &&
    isBuilding &&
    Boolean(detail?.units.length) &&
    linkedUnitIds.size > 0 &&
    !editingLinks &&
    !locked?.unitId;
  const tappedUnitId = matrixActive && shownUnitId && linkedUnitIds.has(shownUnitId) ? shownUnitId : null;
  useEffect(() => {
    onMatrixState?.({ active: matrixActive, unitId: tappedUnitId });
  }, [matrixActive, tappedUnitId, onMatrixState]);
  useEffect(() => () => onMatrixState?.({ active: false, unitId: null }), [onMatrixState]);

  const heldRoles = useMemo(
    () =>
      new Map<string, string>(
        [...linkedUnitIds].map((unitId) => [unitId, draft.occupancyType ?? 'OWNER']),
      ),
    [linkedUnitIds, draft.occupancyType],
  );


  /**
   * Adds or removes the card line that names this canonical unit.
   *
   * Every branch reads `current.units` rather than the `draft` prop, so ticking
   * two flats in quick succession records both. Built from the snapshot, the
   * second tick spread a `units` array that predated the first and dropped it —
   * on a matrix, where ticking several flats in a row is the entire point.
   */
  const toggleUnit = (unit: UnitWithOccupants) =>
    onChange((current) => {
      const units = current.units ?? [];

      if (units.some((row) => row.unitId === unit.id)) {
        return { ...current, units: units.filter((row) => row.unitId !== unit.id) };
      }

      /*
        The canonical values seed the row; the officer can still correct them.

        `floor` crosses a real boundary here — `Unit.floor` is a signed integer
        and `BuildingUnit.floor` is free text — so it is rendered the way a
        person says it rather than as "0". `parseFloorLabel` is the door back
        the other way; this is the door out.

        `unitStatus` falls back to the last row's answer, because `Unit.
        unitStatus` is nullable and usually null: the census records that a flat
        exists long before anybody asks whether it is lived in. Ticking a flat
        therefore produced a row with «حالة الوحدة» blank, and a landlord
        ticking eight of them was asked the same question eight times — which is
        the exact inflation `addUnit` already avoids by inheriting it. The
        canonical answer still wins wherever the census has one.

        The inheritance stops dead at a flat somebody else is living in, and
        that exception is the whole billing fix on this side. A landlord ticking
        eight flats, one of which is let, used to have the *previous* flat's
        «مشغولة من المالك» copied onto the let one — and `bearsFee` then charged
        them the occupancy fee for a flat whose tenant was being charged it too.
        A guess about flat 7 is not evidence about flat 8, least of all when the
        census is holding the answer for flat 8. `occupancyStatusOf` reads it.
      */
      const previous = units.at(-1);
      const occupied = occupancyStatusOf(unit);
      const row: UnitDraft = {
        unitId: unit.id,
        unitType: unit.unitType,
        floor: floorText(unit.floor, en),
        side: unit.side ?? undefined,
        unitArea: unit.unitArea != null ? String(unit.unitArea) : undefined,
        unitStatus: unit.unitStatus ?? occupied ?? previous?.unitStatus,
      };

      /*
        Fill a blank line rather than adding a second one.

        A card can already carry an un-linked row — «إضافة وحدة» pressed before
        the building was chosen, or a row left behind by `unlink`/`startNew`,
        both of which keep the officer's own description and drop only the
        link. Appending on top of one of those left the card showing an empty
        «الوحدة» form directly above the filled-in one, which reads as a unit
        that failed to save.

        Only a genuinely empty line is reused. A row someone has typed into is
        their statement about a different flat and is never overwritten.
      */
      const blankIndex = units.findIndex((row) => !row.unitId && isBlankUnit(row));
      if (blankIndex >= 0) {
        return {
          ...current,
          units: units.map((existing, i) => (i === blankIndex ? row : existing)),
        };
      }

      return { ...current, units: [...units, row] };
    });

  /**
   * Adds a flat to the structure the card is already linked to, and ticks it.
   *
   * The gap this closes: the matrix could only be built when the *building*
   * was, so an officer who linked to an existing block and found a flat the
   * census had never recorded — a محل converted on the ground floor, a floor
   * added since the survey — had nowhere to put it. They either typed it into
   * «وحدات المبنى» as an unlinked row, which bills but never reaches the
   * census, or abandoned the link entirely.
   *
   * Ticked on creation because the only reason to add a flat from *this*
   * screen is that the citizen in front of you holds it. The census gets the
   * unit either way; skipping the tick would leave the officer to hunt for the
   * chip they just created.
   *
   * `unitCode` and `sequence` are the server's to decide — it allocates the
   * next free position on the floor under an advisory lock, which is what stops
   * two officers filling one matrix from colliding. So the row is built from
   * the response, never from what was typed here.
   */
  /** Opens «إضافة وحدة» on a given floor, drawn where it was asked for. */
  const openAdd = (floor: number, anchor: number | 'bottom') => {
    if (!detail) return;
    setAddError(null);
    setDuplicateUnits(null);
    setAdding({
      floor: String(floor),
      // What this structure is made of, exactly as the building editor seeds
      // its own units — a مستودع's next unit is a مستودع until somebody says
      // otherwise, and below ground it is storage whatever stands above it.
      unitType: defaultUnitTypeFor(detail.structureType, floor),
    });
    setAddingAnchor(anchor);
  };

  /**
   * Edits the open «إضافة وحدة» form, re-suggesting the unit type when the
   * floor crosses the ground line.
   *
   * Only where the officer has not chosen a type themselves: an untouched
   * «شقة» on a form whose floor has just been changed to −1 is the old floor's
   * suggestion, not an answer, and leaving it there is how a قبو gets filed as
   * a flat. A type they picked is left exactly as they picked it.
   */
  const changeAdding = (next: { floor: string; unitType: string }) => {
    setDuplicateUnits(null);
    setAdding((current) => {
      if (!current || !detail || next.unitType !== current.unitType) return next;

      const previous = Number(current.floor);
      const untouched =
        Number.isFinite(previous) &&
        current.unitType === defaultUnitTypeFor(detail.structureType, previous);
      const floor = Number(next.floor);
      if (!untouched || !Number.isFinite(floor)) return next;

      return { ...next, unitType: defaultUnitTypeFor(detail.structureType, floor) };
    });
  };

  const closeAdd = () => {
    setAdding(null);
    setAddingAnchor(null);
    setAddError(null);
    setDuplicateUnits(null);
  };

  const submitNewUnit = async (acknowledgedDuplicates = false) => {
    if (!adding || !buildingId || addingBusy) return;

    const floor = Number(adding.floor);
    if (!Number.isInteger(floor)) {
      setAddError(en ? 'Enter a floor number.' : 'أدخل رقم الطابق.');
      return;
    }
    if (!adding.unitType) {
      setAddError(en ? 'Choose a unit type.' : 'اختر نوع الوحدة.');
      return;
    }

    setAddingBusy(true);
    setAddError(null);
    try {
      const created = await addUnit(tenant, token, buildingId, {
        floor,
        unitType: adding.unitType as UpsertUnitInput['unitType'],
        ...(acknowledgedDuplicates ? { acknowledgedDuplicates: true } : {}),
      });

      onChange((current) => ({
        ...current,
        units: [
          ...(current.units ?? []),
          {
            unitId: created.id,
            unitType: created.unitType,
            floor: floorText(created.floor, en),
            side: created.side ?? undefined,
            unitArea: created.unitArea != null ? String(created.unitArea) : undefined,
            // Inherited for the same reason `toggleUnit` inherits it: a flat
            // the census has only just heard of has no status of its own yet.
            unitStatus: created.unitStatus ?? (current.units ?? []).at(-1)?.unitStatus,
          },
        ],
      }));

      setAdding(null);
      setAddingAnchor(null);
      setDuplicateUnits(null);
      setMatrixVersion((version) => version + 1);
    } catch (caught) {
      logApiError(caught);

      /*
        The floor already has a unit of this type, and the server is holding it
        out rather than refusing outright.

        This is the moment «إضافة وحدة» needed and never had. `addUnit`
        allocates the next free position, so a second محل beside an existing محل
        was always created and no constraint could fire — the mistake that put
        one physical shop into the register twice. The candidates arrive with
        the refusal so the prompt can name them without a second request, which
        matters most to the offline phone least able to make one.

        Not an error state: the answer is allowed to be yes.
      */
      const clashes = duplicateUnitsOf(caught);
      if (clashes) {
        setDuplicateUnits(clashes);
        return;
      }

      /*
        Surfaced verbatim where the server sent one. `addUnit` refuses a
        position already taken with «الوحدة رقم ٢ موجودة على هذا الطابق», which
        tells the officer exactly what to change; replacing it with a generic
        failure would send them to look for a problem that is already named.
      */
      setAddError(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not add the unit.'
            : 'تعذّرت إضافة الوحدة.',
      );
    } finally {
      setAddingBusy(false);
    }
  };

  /**
   * Drops the link to the structure — and with it the rows that only existed
   * because of it.
   *
   * The rows carrying a `unitId` were created by ticking flats in the building
   * being unlinked, and every field in them was seeded from that building's
   * matrix. Keeping them was the old behaviour and it produced duplicates on
   * the exact path this control exists for: unlink, change your mind, re-link,
   * re-tick — and the card now held two rows describing one flat, because a
   * stripped row is no longer blank enough for `toggleUnit` to reuse.
   *
   * Rows the officer typed by hand have no `unitId` and never had one. Those
   * are their own statement about a flat and survive untouched, which is the
   * distinction the old blanket "keep everything" could not draw.
   */
  const unlink = () =>
    onChange((current) => ({
      ...current,
      buildingId: undefined,
      pendingBuilding: undefined,
      units: (current.units ?? []).filter((row) => !row.unitId),
    }));

  // ── «منشأة جديدة على هذا العقار» ──────────────────────────────────
  const pending = draft.pendingBuilding ?? null;

  /*
    The default structure type, and why it is only a default.

    `structureTypeForProperty` is the sanctioned inverse of `STRUCTURE_TYPE_MAP`
    (D15) and returns `null` for أرض and خيمة, which is exactly the refusal Q2
    asks for — so the branch below is simply never offered on those cards.

    It is lossy in one direction and the officer has to be able to correct it:
    four structure types collapse onto `BUILDING`, so a مجمع تجاري and a مستودع
    both arrive here as `RESIDENTIAL_BUILDING`.
  */
  const defaultStructureType = structureTypeForProperty(draft.propertyType);

  const startNew = (acknowledged: boolean) => {
    if (!defaultStructureType || !parcelNumber) return;
    const id = mintId();
    onChange((current) => ({
      ...current,
      buildingId: id,
      pendingBuilding: {
        id,
        parcelNumber,
        structureType: defaultStructureType,
        acknowledgedDuplicates: acknowledged,
      },
      // A structure that does not exist yet has no matrix to tick against, so
      // rows that named flats in the *previous* choice are dropped outright —
      // see `unlink` for why stripping the link and keeping the row produced
      // duplicates rather than preserving work.
      units: (current.units ?? []).filter((row) => !row.unitId),
    }));
  };

  /*
    On a parcel the census confirms is empty, the new structure is the answer.

    Nothing stands there, so there is nothing this could be a duplicate of and
    D18's guard cannot fire — which makes the tap a formality rather than an
    acknowledgement, and a formality that costs the census a building every time
    an officer does not notice a control below the fold. It is preselected, and
    the officer can still decline it.

    Deliberately **not** on `'failed'`. Offline the listing is always empty, so
    preselecting there would mint a structure on every field registration
    without anybody having been asked. That case keeps the tap, and says why.

    Guarded four ways so it fires once and never fights anyone: only on a
    confirmed-empty listing, only for a card that can carry a structure, only
    when nothing is already chosen, and never after «بدون ربط».
  */
  useEffect(() => {
    if (locked || declined) return;
    if (lookup !== 'ok' || candidates.length > 0) return;
    if (draft.buildingId || draft.pendingBuilding) return;
    if (!defaultStructureType || !parcelNumber) return;
    startNew(false);
    // `startNew` closes over the draft and would re-run this on every keystroke
    // in the card; the guards above are what decide when it may fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    locked,
    declined,
    lookup,
    candidates.length,
    draft.buildingId,
    draft.pendingBuilding,
    defaultStructureType,
    parcelNumber,
  ]);

  /** «بدون ربط» — an answer, not an absence. */
  const decline = () => {
    setDeclined(true);
    unlink();
  };

  /*
    Nothing to offer, and nothing to say.

    `locked` is the exception, and it used to be the bug: an officer arriving
    from a unit panel's «ملف جديد» link hit this line with an empty card, the whole
    control vanished, and the only sign the flat had been chosen was a hidden
    `buildingId` the form never mentioned again. The card is seeded now, so a
    locked target normally has a parcel — but the seed can fail (the editor
    swallows a lost connection deliberately), and the one state where the
    officer most needs to be told what they are linked to must not be the state
    that renders nothing.
  */
  if (!parcelNumber && !locked) return null;

  // Prefer the loaded building over the parcel listing: with a locked target
  // the listing may still be empty while the detail is already in hand.
  const chosen =
    candidates.find((row) => row.id === buildingId) ??
    (detail && detail.id === buildingId ? detail : null);

  /*
    What the officer may pick between.

    Normally the parcel's own listing. Where that has not arrived — a locked
    target whose parcel lookup is still in flight, or failed — the building
    already in hand stands in for it, so the control shows the structure the
    card is on rather than claiming the parcel has none.
  */
  const options: Array<{
    id: string;
    code: string;
    name: string | null;
    parcelNumber: string;
    structureType: BuildingLedgerRow['structureType'];
  }> = candidates.length > 0 ? candidates : chosen ? [chosen] : [];

  /*
    When the card was launched from a specific unit in the matrix, the building
    and unit are locked and autofilled — so this control has nothing to offer.

    It used to render a compact read-only summary of what had been autofilled:
    «المنشأة في سجل المباني», the building code, the selected unit. That was a
    half-step toward the right answer. Every value in it is locked, none of it
    can be acted on, and the officer arrived here by tapping that exact flat on
    the matrix one screen ago — so it restated their own last action, directly
    above «نوع الإشغال», which is the question they opened the form to answer.

    Now it renders nothing at all. The link is still made (the effect above
    writes `buildingId` onto the card) and still saved; it simply stops taking
    up the top of the screen to say so. The building strip in `PropertyCard` is
    withheld on the same condition, for the same reason.
  */
  if (locked?.unitId) return null;


  return (
    <div className="space-y-3">
    {/*
      Side by side from a tablet up — the card's census facts and the
      structure it is linked to — one under the other on a phone. The two boxes
      stretch to one height, so the row reads as a row.
    */}
    <div className={cn('grid grid-cols-1 gap-3', aside && 'md:grid-cols-2')}>
      {aside}
      <div className="space-y-2 rounded-lg border border-dashed p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Building2 className="size-3.5 text-muted-foreground" aria-hidden />
            {en ? 'Censused structure' : 'المنشأة في سجل المباني'}
            {locked ? (
              <Badge variant="soft-muted" className="gap-1">
                <Lock className="size-3" aria-hidden />
                {en ? 'From the matrix' : 'من مصفوفة الوحدات'}
              </Badge>
            ) : null}
          </p>

          {buildingId && !locked ? (
            <button
              type="button"
              onClick={unlink}
              className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
            >
              <Unlink className="size-3" aria-hidden />
              {en ? 'Unlink' : 'إلغاء الربط'}
            </button>
          ) : null}
        </div>

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {en ? 'Checking the census…' : 'جاري مراجعة سجل المباني…'}
          </p>
        ) : options.length === 0 ? (
          <div className="space-y-1.5">
            {/*
              Two different sentences, because they are two different facts.

              An empty listing used to be printed as "nothing is censused here"
              whether the census said so or could not be reached — and offline,
              where this form mostly lives, it could never say anything else.
              Now that the control can *create* a structure, that conflation is
              the difference between a safe default and one that mints a building
              on every field registration.
            */}
            {lookup === 'failed' ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                {en
                  ? `The census could not be reached, so what stands on parcel ${parcelNumber} is unknown — there may already be a structure recorded here.`
                  : `تعذّر الوصول إلى سجل المباني، فلا يُعرف ما هو مسجَّل على العقار ${parcelNumber} — قد تكون هناك منشأة مسجَّلة بالفعل.`}
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {en
                  ? `No structure has been censused on parcel ${parcelNumber} yet. The card is valid without one — the link can be made later from the census ledger.`
                  : `لا توجد منشأة مسجَّلة على العقار ${parcelNumber} بعد. البطاقة صالحة بدون ربط — يمكن ربطها لاحقاً من سجل المباني.`}
              </p>
            )}

            <NewStructureBranch
              en={en}
              labels={labels}
              locked={Boolean(locked)}
              pending={pending}
              offerable={Boolean(defaultStructureType && parcelNumber)}
              /*
                The tap is required whenever the answer might be "yes, there is
                one already". On a parcel the census confirmed is empty there is
                nothing to duplicate, so this is a one-tap action rather than an
                acknowledgement — but it is still a tap: a building is a row on
                the municipality's register, and creating one is not something a
                form should do because a control went untouched.
              */
              acknowledge={lookup === 'failed'}
              onStart={() => startNew(lookup === 'failed')}
              onCancel={unlink}
              onStructureType={(structureType) =>
                pending
                  ? onChange((current) => applyStructureType(current, pending, structureType))
                  : undefined
              }
            />

            <NoLinkOption
              en={en}
              active={declined}
              hidden={Boolean(locked) || Boolean(pending)}
              onSelect={decline}
            />
          </div>
        ) : (
          <>
            <ul className="flex flex-wrap gap-1.5">
              {options.map((row) => {
                const active = row.id === buildingId;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      disabled={Boolean(locked)}
                      onClick={() =>
                        onChange((current) => ({
                          ...current,
                          buildingId: active ? undefined : row.id,
                        }))
                      }
                      aria-pressed={active}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'hover:bg-accent disabled:opacity-50',
                      )}
                    >
                      {active ? <Check className="size-3" aria-hidden /> : null}
                      <span dir="ltr" className="font-mono font-semibold">
                        {row.code}
                      </span>
                      {row.name ? <span className="truncate">{row.name}</span> : null}
                      <span className="text-muted-foreground">
                        {labels.structureType[row.structureType]}
                      </span>
                      {/* Filed under a neighbouring parcel and covering this one —
                          said, because its code names a different عقار. */}
                      {parcelNumber && row.parcelNumber !== parcelNumber ? (
                        <span className="text-xs text-info">
                          {en
                            ? `shared — filed under ${row.parcelNumber}`
                            : `مشترك — عقاره الأساسي ${row.parcelNumber}`}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/*
              No structure summary here, deliberately.

              The building sheet leads with «٤ طوابق · ٣ من ٧ ممسوحة» because that
              screen is *about* the structure. This one is about a household: the
              officer has already picked the building above, and a row of census
              statistics between that choice and the flats they came to tick is
              answering a question nobody on this screen asked. The matrix below
              carries what is actually needed per unit.
            */}
            {/*
              A second structure on an occupied parcel — D18's moment of noticing.

              The candidates are listed *above* this, which is the whole point:
              the officer has been shown what is already recorded here and is
              saying this is none of them. That statement is what the server's
              guard asks for, and tapping this is what sets it — which is also
              why nothing here is preselected. Not touching a control is evidence
              of a control below the fold, never of a new building.
            */}
            {!locked && !chosen ? (
              <NewStructureBranch
                en={en}
                labels={labels}
                locked={false}
                pending={pending}
                offerable={Boolean(defaultStructureType && parcelNumber)}
                acknowledge
                occupied={options.length}
                onStart={() => startNew(true)}
                onCancel={unlink}
                onStructureType={(structureType) =>
                  pending
                  ? onChange((current) => applyStructureType(current, pending, structureType))
                  : undefined
                }
              />
            ) : null}

            <NoLinkOption
              en={en}
              active={declined}
              hidden={Boolean(locked) || Boolean(chosen) || Boolean(pending)}
              onSelect={decline}
            />
          </>
        )}

        {/*
          The card says «منزل مستقل»; the structure it is linked to has a matrix.

          Only a بناية card carries unit lines — a منزل is one dwelling, described
          by the side/area/shared-rights fields on the card itself — so the picker
          below correctly renders nothing here. Said out loud because the silence
          was the bug: an officer linked a block, saw it had flats, and had no
          unit list and no reason given. They ticked nothing, the card saved with
          a `buildingId` and no `unitId`, and the matrix stayed empty with nobody
          anywhere told why.
        */}
        {buildingId && !isBuilding && detail && detail.units.length > 1 ? (
          <div className="space-y-1 border-t pt-2">
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                {en
                  ? `${chosen?.code ?? 'This structure'} has ${detail.units.length} units on the census. A «house» card describes one dwelling, so no unit can be named on it — set نوع العقار above to «بناية» to record which of them this citizen holds.`
                  : `${chosen?.code ?? 'هذه المنشأة'} تحتوي ${detail.units.length} وحدة في سجل المباني. بطاقة «منزل مستقل» تصف مسكناً واحداً ولا يمكن ربط وحدة بها — اختر «بناية» في نوع العقار أعلاه لتحديد الوحدات التي يملكها هذا المواطن.`}
              </span>
            </p>
          </div>
        ) : null}
      </div>
    </div>

      {/* ── The flats this citizen actually holds — full width, under the row ── */}
      {buildingId && isBuilding ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium">
              {editingLinks
                ? en
                  ? 'Which units does this citizen hold?'
                  : 'أي وحدات يملك/يشغل هذا المواطن؟'
                : en
                  ? "This citizen's units in the building"
                  : 'وحدات هذا المواطن في المبنى'}
            </p>
            
          </div>

          {detailLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {en ? 'Loading the matrix…' : 'جاري تحميل المصفوفة…'}
            </p>
          ) : !detail || detail.units.length === 0 ? (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {en
                  ? 'This structure has no unit matrix yet. Add the flats here to put them in the census, or record them on the card below.'
                  : 'لا توجد مصفوفة وحدات لهذه المنشأة بعد. أضف الوحدات هنا لتدخل سجل المباني، أو سجّلها في البطاقة أدناه.'}
              </p>
              {detail ? (
                <AddUnitInline
                  en={en}
                  labels={labels}
                  state={adding}
                  busy={addingBusy}
                  error={addError}
                  onOpen={() => openAdd(0, 'bottom')}
                  onChange={changeAdding}
                  onCancel={closeAdd}
                  onSubmit={() => void submitNewUnit()}
                  duplicates={duplicateUnits}
                  onConfirmDuplicates={() => void submitNewUnit(true)}
                  onDeclineDuplicates={() => {
                    setDuplicateUnits(null);
                    setAdding(null);
                  }}
                />
              ) : null}
            </>
          ) : !editingLinks ? (
            <div className="space-y-3">
              <UnitHoldingsGrid
                floors={gridFloors}
                held={heldRoles}
                selectedUnitId={shownUnitId}
                onSelect={setShownUnitId}
                locale={locale}
              />
              {/* The flat tapped opens its own fields under this box — see the card. */}
            </div>
          ) : (
            <>
              {/*
                Floor by floor, the way the building sheet draws it — because
                the floor is what the officer is standing on. A wrapped run of
                chips put «0001», a ground-floor محل, beside «0301» with nothing
                between them, and «the shop downstairs» was unfindable in it.
              */}
              <div className="space-y-2">
                {floors.map(({ floor, units }) => (
                  <div key={floor} className="rounded-lg border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-2.5 py-1.5">
                      <p className="text-xs font-semibold">{floorLabel(floor, en)}</p>
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-muted-foreground">
                          {en ? `${units.length} units` : `${units.length} وحدة`}
                        </p>
                        {/*
                          Per floor, because the floor is the thing being
                          looked at — and because an officer sent to one
                          specific door has nothing to add but a duplicate of
                          the flat they are standing in.
                        */}
                        {locked?.unitId || addingAnchor === floor ? null : (
                          <button
                            type="button"
                            disabled={addingBusy}
                            onClick={() => openAdd(floor, floor)}
                            className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                          >
                            <Plus className="size-3" aria-hidden />
                            {en ? 'Add unit' : 'إضافة وحدة'}
                          </button>
                        )}
                      </div>
                    </div>

                    {adding && addingAnchor === floor ? (
                      <div className="border-b bg-background px-2.5 py-2">
                        <AddUnitInline
                          en={en}
                          labels={labels}
                          state={adding}
                          busy={addingBusy}
                          error={addError}
                          onOpen={() => openAdd(floor, floor)}
                          onChange={changeAdding}
                          onCancel={closeAdd}
                          onSubmit={() => void submitNewUnit()}
                          duplicates={duplicateUnits}
                          onConfirmDuplicates={() => void submitNewUnit(true)}
                          onDeclineDuplicates={closeAdd}
                        />
                      </div>
                    ) : null}

                    {units.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                        {en
                          ? 'The register says this level exists but no unit has been recorded on it yet.'
                          : 'سجل المباني يذكر هذا الطابق لكن لم تُسجَّل عليه أي وحدة بعد.'}
                      </p>
                    ) : null}

                    <ul className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-2 xl:grid-cols-3 empty:p-0">
                      {units.map((unit) => {
                        const active = linkedUnitIds.has(unit.id);
                        const occupants = currentOccupants(unit);
                        const badge = cellBadge(unit, labels, en);
                        /*
                          Whose occupancy, not merely whether there is one.

                          This used to be `occupants.some(current)` under the
                          name `takenBySomeoneElse` — a variable that did not
                          check *whose*, because the control was never told which
                          citizen it was editing. So an owner already recorded in
                          flat 3 was warned about himself, and an owner ticking a
                          genuinely let flat got the identical amber dot. One of
                          those is nothing and the other decides who pays the
                          رسم نظافة; they cannot look the same.
                        */
                        const mine = citizenId
                          ? occupants.filter((occupant) => occupant.citizenId === citizenId)
                          : [];
                        const others = citizenId
                          ? occupants.filter((occupant) => occupant.citizenId !== citizenId)
                          : occupants;
                        /*
                          Only a *non-owner* spell is a fee-bearing collision.
                          Two owners on one flat are co-heirs, which Lebanese
                          inheritance makes the normal case (D2) and which costs
                          nobody anything.
                        */
                        const heldByOccupant = others.some(
                          (occupant) => occupant.role !== 'OWNER',
                        );

                        return (
                          <li key={unit.id}>
                            <button
                              type="button"
                              disabled={Boolean(locked?.unitId) && locked?.unitId !== unit.id}
                              onClick={() => toggleUnit(unit)}
                              aria-pressed={active}
                              className={cn(
                                'w-full space-y-1 rounded-md border p-2.5 text-start transition-colors',
                                active
                                  ? 'border-primary bg-primary/10 ring-1 ring-primary'
                                  : 'hover:bg-accent/50 disabled:opacity-40',
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1 font-mono text-sm font-bold">
                                  {active ? (
                                    <Link2 className="size-3 shrink-0" aria-hidden />
                                  ) : null}
                                  <span dir="ltr">{unit.unitCode}</span>
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {labels.unitType[unit.unitType]}
                                </span>
                              </div>

                              {/* The same classification the building sheet
                                  colours its cells by — «شاغرة», «غير ممسوحة»,
                                  «مسجلة (المستأجر: فلان)». */}
                              <Badge variant={badge.variant} className="max-w-full truncate">
                                {badge.text}
                              </Badge>

                              {/*
                                What the officer needs to recognise the flat
                                from the doorway, which a bare code never gave
                                them: an officer registering the owner of «the
                                shop on the ground floor» saw «0001» and had no
                                way to tell whether that *was* their shop.
                              */}
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                                {unit.postedNumber && unit.postedNumber !== unit.unitCode ? (
                                  <span>
                                    {en ? 'Door: ' : 'الباب: '}
                                    <span dir="ltr">{unit.postedNumber}</span>
                                  </span>
                                ) : null}
                                {unit.side ? <span>{unit.side}</span> : null}
                                {unit.unitArea != null ? (
                                  <span dir="ltr">
                                    {unit.unitArea} {en ? 'm²' : 'م²'}
                                  </span>
                                ) : null}
                              </div>

                              {/*
                                Who is in it, by name and capacity. The owner's
                                own spell is named separately so the commonest
                                reason a card lights up — that this is the very
                                person being edited — stops reading as a clash.
                              */}
                              {mine.length > 0 ? (
                                <p className="text-xs font-medium text-primary">
                                  {en ? 'Already linked to this citizen' : 'مسجَّل لهذا المواطن'}
                                  {' · '}
                                  {mine.map((row) => labels.occupancyRole[row.role]).join('، ')}
                                </p>
                              ) : null}

                              {others.map((occupant) => (
                                <p
                                  key={occupant.id}
                                  className={cn(
                                    'text-xs',
                                    occupant.role === 'OWNER'
                                      ? 'text-muted-foreground'
                                      : 'font-medium text-warning',
                                  )}
                                >
                                  {labels.occupancyRole[occupant.role]}
                                  {': '}
                                  {occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}
                                </p>
                              ))}

                              {/*
                                Said once, plainly, where it changes the bill.

                                A flat somebody else occupies is «مؤجرة» or
                                «مشغولة بتسامح» on this card whether or not
                                anyone types it, and `toggleUnit` writes exactly
                                that. Announcing it here is what stops the
                                owner's card asserting «مشغولة من المالك» over a
                                tenant the register is already holding — the
                                state in which both of them get charged the
                                occupancy fee for one flat.
                              */}
                              {heldByOccupant ? (
                                <p className="text-xs text-warning">
                                  {en
                                    ? 'Occupied by someone else — this card will record it as such'
                                    : `تُسجَّل على هذه البطاقة «${
                                        labels.unitStatus[occupancyStatusOf(unit) ?? 'RENTED']
                                      }»`}
                                </p>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                {en
                  ? 'Nothing is selected by default — a twelve-flat building says nothing about how many of them one person holds.'
                  : 'لا شيء محدَّد افتراضياً — وجود اثنتي عشرة شقة في مبنى لا يعني أن الشخص يملكها كلها.'}
              </p>

              {/*
                A flat the census has not heard of, added from the form that
                needed it.

                The matrix could only be built at the same time as the building,
                so an officer who linked to an existing block and found an extra
                flat — a ground-floor محل converted since the survey, a floor
                added on top — had no chip to tick. They typed it into «وحدات
                المبنى» as an unlinked row, which bills the citizen but leaves
                the census still saying the flat does not exist.

                Withdrawn when the officer was sent to one specific door.
                A unit panel's «ملف جديد» link names a flat, every other chip on the
                matrix is disabled behind it, and the flat itself is already
                ticked — so the only thing this control can add from here is a
                second row for the unit they are standing in. That is exactly
                the duplicate `duplicateUnitsOf` exists to catch, arrived at by
                the one path where the answer cannot be «نعم، وحدة أخرى».

                Kept for a building-level lock. Arriving from the *structure*
                rather than a door is the case the control was built for: the
                officer is going through the block and may well find a flat the
                survey missed.

                Beside the per-floor buttons rather than instead of them: this
                is the one that adds a floor the matrix does not have yet, so it
                seeds a floor *above* the top of the building.
              */}
              {locked?.unitId || (adding !== null && addingAnchor !== 'bottom') ? null : (
                <AddUnitInline
                  en={en}
                  labels={labels}
                  state={addingAnchor === 'bottom' ? adding : null}
                  busy={addingBusy}
                  error={addError}
                  // Seeded one above the top floor already in the matrix: every
                  // floor the building has has its own button now, so what is
                  // left for this one is the floor that was just built.
                  onOpen={() =>
                    openAdd(Math.max(...detail.units.map((unit) => unit.floor)) + 1, 'bottom')
                  }
                  onChange={changeAdding}
                  onCancel={closeAdd}
                  onSubmit={() => void submitNewUnit()}
                  duplicates={duplicateUnits}
                  onConfirmDuplicates={() => void submitNewUnit(true)}
                  onDeclineDuplicates={closeAdd}
                />
              )}

            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * «بدون ربط بسجل المباني» — the third answer, said out loud.
 *
 * "No link" and "the officer never looked at this control" were the same state:
 * `buildingId` undefined, nothing on screen, and a card that saved into the
 * register having taught the census nothing. A third of the cards in the first
 * municipality to use this are in exactly that state, and no screen anywhere
 * says so.
 *
 * It is a legitimate answer — a card filed before anyone has surveyed the
 * parcel is the normal case, not an error — so this is an option and not a
 * warning. What it stops being is silent: choosing it is a decision the officer
 * can see they made, and the save-time check knows not to ask again.
 */
function NoLinkOption({
  en,
  active,
  hidden,
  onSelect,
}: {
  en: boolean;
  active: boolean;
  /** A locked card, or one that has already answered another way. */
  hidden: boolean;
  onSelect: () => void;
}) {
  if (hidden) return null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md border px-2.5 py-2 text-start text-xs transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-dashed hover:bg-accent',
      )}
    >
      {active ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
      <span>
        <span className="font-medium">
          {en ? 'No census link for this card' : 'بدون ربط بسجل المباني'}
        </span>
        <span className="block text-muted-foreground">
          {en
            ? 'The card is valid without one. It can be linked later from the census ledger.'
            : 'البطاقة صالحة بدونه. يمكن ربطها لاحقاً من سجل المباني.'}
        </span>
      </span>
    </button>
  );
}

/**
 * «منشأة جديدة على هذا العقار» — the register-first creation branch.
 *
 * The building is not created here. This records the officer's intent and mints
 * the id the row will carry; `CitizenEditor` issues the creation at submit
 * time, before the registration, so a card can never name a structure that
 * failed to be made. See `PropertyDraft.pendingBuilding`.
 *
 * **No pin, deliberately (D19).** The parcel centroid is the middle of the
 * plot, where no building stands; offered to every structure on a parcel it
 * produces byte-identical coordinates that no clustering rule can separate; and
 * stored in the column that means "the entrance", a guess becomes
 * indistinguishable from a surveyed fact. A building created here simply has no
 * dot of its own until somebody stands at its door and places one — its
 * residents are drawn on the parcel meanwhile, which is the honest rendering of
 * "nobody has located this yet", and the ledger lists it under «بلا مدخل
 * مُثبت» so the gap is work rather than debt.
 */
function NewStructureBranch({
  en,
  labels,
  locked,
  pending,
  offerable,
  acknowledge,
  occupied,
  onStart,
  onCancel,
  onStructureType,
}: {
  en: boolean;
  labels: ReturnType<typeof getLabels>;
  locked: boolean;
  pending: NonNullable<PropertyDraft['pendingBuilding']> | null;
  offerable: boolean;
  /** Whether choosing this is an assertion about what else is on the parcel. */
  acknowledge: boolean;
  /** How many structures are already recorded here, when any are. */
  occupied?: number;
  onStart: () => void;
  onCancel: () => void;
  onStructureType: (value: StructureType) => void;
}) {
  /*
    أرض and خيمة never reach this.

    `structureTypeForProperty` returns null for both — land has nothing standing
    on it and a tent stays a bare card (Q2) — and `branchFieldsOnly` drops
    `buildingId` on them server-side regardless. Offering the control and then
    silently discarding what it produced is the failure mode `census-link.spec`
    exists to catch.
  */
  if (!offerable || locked) return null;

  if (pending) {
    return (
      <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
            <Plus className="size-3" aria-hidden />
            {en ? 'A new structure will be created' : 'ستُنشأ منشأة جديدة على هذا العقار'}
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
          >
            {en ? 'Cancel' : 'تراجع'}
          </button>
        </div>

        <Select value={pending.structureType} onValueChange={(v) => onStructureType(v as StructureType)}>
          <SelectTrigger className="h-8 text-xs" aria-label={en ? 'Structure type' : 'نوع المنشأة'}>
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
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onStart}
      className="flex w-full items-center gap-1.5 rounded-md border border-dashed px-2.5 py-2 text-start text-xs transition-colors hover:bg-accent"
    >
      <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span>
        <span className="font-medium">
          {en ? 'New structure on this parcel' : 'منشأة جديدة على هذا العقار'}
        </span>
        {acknowledge ? (
          <span className="block text-muted-foreground">
            {occupied
              ? en
                ? `Confirms this is not one of the ${occupied} already recorded here.`
                : `يؤكّد أنها ليست إحدى المنشآت الـ${occupied} المسجَّلة هنا.`
              : en
                ? 'Confirms one should be created even though the census could not be checked.'
                : 'يؤكّد إنشاءها رغم تعذّر مراجعة سجل المباني.'}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * A signed floor rendered the way a person says it.
 *
 * `Unit.floor` is an integer and `BuildingUnit.floor` is free text, so seeding a
 * card row from a canonical unit crosses that boundary. `parseFloorLabel` is the
 * door back the other way; this is the door out, and it writes «الأرضي» rather
 * than «0» because that is what the register has always held.
 */
function floorText(floor: number, en: boolean): string {
  /*
    `B1`, not «قبو ١» — and this is the one place where the choice is load-
    bearing rather than cosmetic. What this returns is written into
    `BuildingUnit.floor`, a free-text column, and `parseFloorLabel` is the door
    back to a signed integer. Its basement pattern accepts `b1` precisely
    because that is what `formatUnitCode` prints, so a card line written here
    reads back as −1 by the same rule a collector's transcription of the code
    does.
  */
  if (floor < 0) return `B${Math.abs(floor)}`;
  if (floor === 0) return en ? 'Ground' : 'الأرضي';
  return String(floor);
}

/**
 * The spells running in this flat right now, newest first.
 *
 * Sorted here rather than trusted from the wire: the matrix orders occupancies
 * by `toDate` then `fromDate`, which puts *ended* spells first under Postgres'
 * NULLS LAST, and every reader that wanted "who is in there" was taking
 * whichever current row happened to come back first.
 */
function currentOccupants(unit: UnitWithOccupants) {
  return unit.occupants
    .filter((occupant) => occupant.toDate === null)
    .sort((a, b) => (a.fromDate < b.fromDate ? 1 : -1));
}

/**
 * The حالة الوحدة this flat's occupancies imply, or undefined for none.
 *
 * The client half of the rule the two write paths now apply server-side: a
 * non-owner spell settles the state of the unit, and an OWNER spell does not —
 * a deed is not a statement of residence.
 *
 * Only ever used to *fill a blank*, never to overwrite. Where the census has
 * already recorded a status that one it wins, which is the same precedence
 * `preferLinked` applies when the bill is computed.
 */
function occupancyStatusOf(unit: UnitWithOccupants): UnitStatus | undefined {
  const roles = new Set(currentOccupants(unit).map((occupant) => occupant.role));
  // RENTED ahead of FREE_OCCUPIED where a flat somehow carries both, matching
  // migration 0035: a عقد إيجار is the fact with a fee schedule behind it.
  if (roles.has('TENANT')) return 'RENTED';
  if (roles.has('FREE_OCCUPANT')) return 'FREE_OCCUPIED';
  return undefined;
}

/**
 * A unit line nobody has typed into yet.
 *
 * `unitType` and `unitStatus` are excluded on purpose: «إضافة وحدة» seeds both
 * from the previous row, so a freshly added line already carries them and
 * would never look blank by an "every field is empty" test — which is exactly
 * the line that should be reused when the officer then ticks a flat on the
 * matrix. What marks a line as really answered is the detail somebody had to
 * look up: which floor, which side, how big, and whether it names a canonical
 * unit.
 */
function isBlankUnit(unit: UnitDraft): boolean {
  const empty = (value: unknown) => value === undefined || value === null || value === '';
  return (
    empty(unit.unitId) &&
    empty(unit.floor) &&
    empty(unit.side) &&
    empty(unit.unitArea) &&
    (unit.sharedRights ?? []).length === 0
  );
}

/**
 * «إضافة وحدة إلى هذا المبنى» — a floor, a type, and nothing else.
 *
 * Deliberately two fields. The census needs to know that a flat exists and
 * roughly what it is; area, side and حالة الوحدة are asked immediately
 * afterwards by the `UnitFields` form that appears under the new chip, and
 * asking them twice — once to create, once to describe — is how a two-tap
 * correction becomes a form people avoid.
 *
 * `unitCode` is absent for the same reason: it is `floor × 100 + sequence`,
 * derived by the server under a lock so two officers filling one matrix cannot
 * both claim `0301`. A field for it here would be a number the officer could
 * get wrong and the server would overrule.
 */
function AddUnitInline({
  en,
  labels,
  state,
  busy,
  error,
  onOpen,
  onChange,
  onCancel,
  onSubmit,
  duplicates,
  onConfirmDuplicates,
  onDeclineDuplicates,
}: {
  en: boolean;
  labels: ReturnType<typeof getLabels>;
  /** Null while closed. */
  state: { floor: string; unitType: string } | null;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onChange: (next: { floor: string; unitType: string }) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /**
   * The units already on this floor, when the server refused for want of an
   * acknowledgement. Null while nothing has been asked.
   */
  duplicates: DuplicateUnitCandidate[] | null;
  /** «نعم، هذه وحدة مختلفة» — re-sends the same unit with the flag set. */
  onConfirmDuplicates: () => void;
  /** «لا، إنها إحداها» — abandons the addition and closes the sub-form. */
  onDeclineDuplicates: () => void;
}) {
  if (!state) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3" aria-hidden />
        {en ? 'Add a unit to this building' : 'إضافة وحدة إلى هذا المبنى'}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="block text-xs font-medium">{en ? 'Floor' : 'الطابق'}</span>
          <input
            type="number"
            inputMode="numeric"
            min={-10}
            max={100}
            dir="ltr"
            value={state.floor}
            onChange={(event) => onChange({ ...state, floor: event.target.value })}
            className="h-8 w-20 rounded-md border bg-background px-2 text-start text-xs"
          />
          {/* The one place the signed floor is typed rather than clicked, so
              the mapping between it and the B-prefixed label is stated. */}
          <span className="block text-xs leading-snug text-muted-foreground">
            {en ? '0 = ground · -1 = B1' : '0 = الأرضي · ‎-1 = B1'}
          </span>
        </label>

        <label className="min-w-40 flex-1 space-y-1">
          <span className="block text-xs font-medium">
            {en ? 'Unit type' : 'نوع الوحدة'}
          </span>
          <Select
            value={state.unitType}
            onValueChange={(unitType) => onChange({ ...state, unitType })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={en ? 'Select…' : 'اختر…'} />
            </SelectTrigger>
            <SelectContent>
              {/*
                `INDEPENDENT_HOUSE` is excluded here exactly as it is in the
                card's own unit list: a منزل مستقل is what a whole card is, not
                a unit inside a block.
              */}
              {BUILDING_UNIT_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {labels.unitType[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <button
          type="button"
          disabled={busy || duplicates !== null}
          onClick={onSubmit}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          {en ? 'Add' : 'إضافة'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="h-8 px-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          {en ? 'Cancel' : 'إلغاء'}
        </button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {en
          ? 'The unit is added to the census and ticked for this citizen. Its code is assigned from the floor.'
          : 'تُضاف الوحدة إلى سجل المباني وتُحدَّد لهذا المواطن. يُشتق رمزها من الطابق.'}
      </p>

      {/*
        The floor already has one of these — the moment of noticing.

        `addUnit` takes the next free position on the floor, so nothing in the
        database could ever refuse a second محل beside an existing محل: the
        unique `(buildingId, floor, sequence)` is satisfied by construction.
        That is how one physical shop came to be in the register twice, and it
        is the same hole D18 closed one level up for structures on a parcel.

        Shown rather than refused, because four flats a floor is ordinary and a
        guard that says no is a guard officers learn to route around. What it
        must not be is absent: the two units look identical from this form, and
        only the names below tell them apart.
      */}
      {duplicates && duplicates.length > 0 ? (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
          <p className="flex items-start gap-1.5 text-xs font-medium leading-relaxed">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {en
              ? 'This floor already has a unit of the same type. Is the one you are adding different?'
              : 'يوجد على هذا الطابق وحدة من النوع نفسه. هل الوحدة التي تضيفها مختلفة عنها؟'}
          </p>

          <ul className="space-y-1">
            {duplicates.map((row) => (
              <li
                key={row.id}
                className="rounded-md bg-background/70 px-2 py-1.5 text-xs leading-relaxed"
              >
                <span className="font-mono font-medium" dir="ltr">
                  {row.unitCode}
                </span>
                {row.postedNumber && row.postedNumber !== row.unitCode ? (
                  <span className="text-muted-foreground" dir="ltr">
                    {' '}
                    ({row.postedNumber})
                  </span>
                ) : null}
                <span className="text-muted-foreground">
                  {' — '}
                  {[
                    labels.unitType[row.unitType],
                    row.side,
                    row.unitArea != null ? (en ? `${row.unitArea} m²` : `${row.unitArea} م²`) : null,
                    row.unitStatus ? labels.unitStatus[row.unitStatus] : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>

                {/*
                  The names are what actually answer the question. A floor whose
                  one محل already has a مستأجر on it is a floor where this
                  button is almost certainly the wrong one.
                */}
                {row.occupants.length > 0 ? (
                  <span className="mt-0.5 block font-medium">
                    {row.occupants
                      .map(
                        (occupant) =>
                          `${labels.occupancyRole[occupant.role]}: ${
                            occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')
                          }`,
                      )
                      .join('، ')}
                  </span>
                ) : (
                  <span className="mt-0.5 block text-muted-foreground">
                    {en ? 'No occupant recorded' : 'لا يوجد شاغل مسجَّل'}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onConfirmDuplicates}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              {en ? 'Yes, it is a different unit' : 'نعم، هذه وحدة مختلفة'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDeclineDuplicates}
              className="h-7 px-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            >
              {en ? 'No — it is one of these' : 'لا، إنها إحدى هذه الوحدات'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Records a change of نوع المنشأة, and lets it reach the unit rows.
 *
 * `STRUCTURE_TYPE_MAP` says what a structure is made of — a مجمع تجاري of
 * محال, a مستودع of مستودعات — and the building editor has always applied it:
 * changing the structure type there re-seeds the blueprint's unit type. This
 * control offered the identical list and changed nothing but a label, so the
 * same building created from the two screens came out differently.
 *
 * Applied only to rows nobody has answered yet. A row whose «نوع الوحدة» the
 * officer has set is their statement about that flat — a ground-floor محل in a
 * مبنى سكني is the ordinary case, not a contradiction to be tidied away — and
 * overwriting it would silently undo a deliberate answer on a control two
 * sections above it.
 */
function applyStructureType(
  current: PropertyDraft,
  pending: NonNullable<PropertyDraft['pendingBuilding']>,
  structureType: StructureType,
): PropertyDraft {
  const defaultUnitType = STRUCTURE_TYPE_MAP[structureType].defaultUnitType;

  return {
    ...current,
    pendingBuilding: { ...pending, structureType },
    units: (current.units ?? []).map((row) =>
      row.unitType ? row : { ...row, unitType: defaultUnitType },
    ),
  };
}
