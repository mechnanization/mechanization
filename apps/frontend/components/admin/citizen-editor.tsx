'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CloudOff, UserPlus, UserRoundPen } from 'lucide-react';
import {
  ApiRequestError,
  createCitizen,
  getBuilding,
  getCase,
  getCitizenForm,
  getTenantConfig,
  logApiError,
  updateCase,
  updateCitizen,
} from '@/lib/api-client';
import type { BuildingDetail, CaseSummary, CensusSyncResult } from '@/lib/api-client';
import type { PublicTenantConfig } from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import type { PropertyDraft, UnitDraft } from '@/components/citizen/property-card';
import { LoadingState } from '@/components/ui/states';
import { flagsFromArray, flagsToArray, unverifiedFromArray } from '@/components/ui/field';
import { ShellLink, shellNavigate } from './shell-nav';
import { OfflineQueueNotice } from './offline-queue';
import { offlineStorageAvailable } from '@/lib/offline-db';
import {
  getQueuedSubmission,
  queueSubmission,
  reviseSubmission,
  useOfflineQueue,
  useOnlineStatus,
} from '@/lib/offline-sync';
import { useToast } from '@/components/ui/toast';
import {
  CitizenForm,
  emptyCitizen,
  toPayloadProperty,
  type CitizenFormValues,
} from './citizen-form';
import { STRUCTURE_TYPE_MAP } from '@mechanization/shared-schemas';
import type { LockedCensusTarget } from './building-unit-picker';

/** `null`/`undefined` → absent; a number → the string an `<input>` holds. */
function text(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
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
function announceCensus(
  census: CensusSyncResult | null,
  toast: ReturnType<typeof useToast>,
  locale: string,
): void {
  const en = locale === 'en';

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
  if (linked === 0 && census.casesResolved === 0 && census.buildingsNamed === 0) return;

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
  ].filter(Boolean);

  toast.success(en ? 'Census updated' : 'تم تحديث سجل المباني', {
    description: parts.join(en ? ' · ' : ' · '),
  });
}

/**
 * What the census already knows about the flat the officer just tapped.
 *
 * The «تسجيل أسرة في هذه الوحدة» button used to carry two UUIDs in a
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
    occupancyType: property.occupancyType as PropertyDraft['occupancyType'],
    landlordName: text(property.landlordName),
    landlordPhone: text(property.landlordPhone),
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
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  citizenId?: string;
  queueId?: string;
  fromCaseId?: string;
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
  const [error, setError] = useState<string | null>(null);

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

          setInitial(seeded ? { ...empty, properties: seeded } : empty);
          return;
        }

        setReference(form.referenceNumber);
        setInitial({
          // The record's existing «غير مؤكَّد» flags, so whoever opens it to
          // finish sees which blanks were deliberate and what was said about
          // each — and clears one simply by filling the field in.
          flags: flagsFromArray(form.flags ?? []),
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
        });
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
  }, [tenant, token, citizenId, queueId, fromCaseId, base, router, locale]);

  const submit = useCallback(
    async (values: CitizenFormValues) => {
      if (!token) return;
      setSubmitting(true);
      setError(null);

      const payload = {
        personal: values.personal,
        contact: values.contact,
        properties: values.properties.map(toPayloadProperty),
        flags: flagsToArray(values.flags),
      };

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

      try {
        if (citizenId) {
          const updated = await updateCitizen(tenant, token, citizenId, payload);
          announceCensus(updated.census, toast, locale);
          router.push(`${base}/citizens/${citizenId}`);
        } else {
          const created = await createCitizen(tenant, token, payload);
          announceCensus(created.census, toast, locale);

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

          router.push(`${base}/citizens/${created.citizenId}`);
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
    [tenant, token, citizenId, queueId, fromCaseId, base, router, locale, willQueue, canQueue, toast],
  );

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

      <CitizenForm
        tenant={tenant}
        token={token}
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
        onCancel={() => shellNavigate(router, cancelHref)}
        locale={locale}
        lockedCensusTarget={lockedCensusTarget}
      />
    </div>
  );
}
