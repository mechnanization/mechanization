import type {
  CardRemovalReason,
  CitizenResidence,
  LandType,
  OccupancyType,
  PropertyType,
  StructureType,
  UnitStatus,
  UnitType,
} from '@mechanization/shared-schemas';

/*
  What a citizen form edits, as plain types (ARCH-20).

  They were declared in `components/admin/citizen-form.tsx` and
  `components/citizen/property-card.tsx`, which made the drafts, the seed and
  the residence move — all of them `lib` — import from components, against the
  direction `app → components → lib`. Both components still export these names,
  so no importer changed.
*/

/**
 * What the officer said when removing a saved card — see `cardRemovalSchema`.
 * `endedAt` is a `YYYY-MM-DD` from the date box, only for a sale.
 */
export interface CardRemovalAnswer {
  reason: CardRemovalReason;
  endedAt?: string;
}

export interface UnitDraft {
  /** The stored row this line was loaded from, on an edit. Never typed. */
  id?: string;
  /**
   * The canonical `Unit` this line describes, when the officer linked one.
   *
   * Set by `BuildingUnitPicker` and never typed. Where it is present the
   * census record outranks this row field by field (P2-T8); where it is absent
   * — a card filed before the building was surveyed — this row is all there is,
   * and that is permanent rather than transitional.
   */
  unitId?: string;
  unitType?: UnitType;
  floor?: string;
  side?: string;
  unitArea?: string;
  sharedRights?: string[];
  /** حالة الوحدة. Undefined is "not recorded", which is not «مشغولة». */
  unitStatus?: UnitStatus;
}

export interface PropertyDraft {
  id?: string;
  /** The censused structure this card is about, when one was linked (§3.7). */
  buildingId?: string;
  /**
   * Set when the officer chose «منشأة جديدة على هذا العقار» and the building
   * does not exist yet.
   *
   * `buildingId` is filled in at the same moment, with the id carried here —
   * the browser mints it, and `clientSubmissionId` makes it the row's primary
   * key, so every other part of the form can reference the structure before it
   * has been sent. The creation itself is issued at submit time, before the
   * registration, because a card must never name a building that failed to be
   * made.
   *
   * Stripped by `toPayloadProperty`: this describes work still to be done, not
   * a field of the card.
   */
  pendingBuilding?: {
    /** Minted in the picker; becomes `Building.id` via `clientSubmissionId`. */
    id: string;
    parcelNumber: string;
    structureType: StructureType;
    /**
     * «تحقَّقت، وهذه منشأة مختلفة» (D18), or "the census could not be reached
     * and a person said to create one anyway". Both are a human answering the
     * question, which is the only thing the server's guard is asking for.
     */
    acknowledgedDuplicates: boolean;
  };
  occupancyType?: OccupancyType;
  landlordName?: string;
  landlordPhone?: string;
  /**
   * «نعم، هو المالك» — the registered citizen the officer agreed this card names.
   *
   * Set by `LandlordMatchHint` when a lookup on `landlordPhone` turns up exactly
   * one citizen and the officer confirms it; cleared whenever the number
   * changes, because the agreement was about that number. It rides with the
   * submission so the link is made by the save — a browser doing it afterwards
   * never runs on the offline queue this form files most of its records through.
   *
   * The server does not believe it: `LandlordLinkService.confirm` re-derives the
   * match from the committed card and refuses any citizen whose numbers differ
   * from it. See `landlordCitizenIdField` in the property schema.
   */
  landlordCitizenId?: string;
  /**
   * The owner link the server already holds for this card, as loaded for edit.
   *
   * Different from `landlordCitizenId`, which is an answer this form is about to
   * send. A standing link locks the owner's number *and* name — the number is
   * what it was confirmed about, and the name shown is the owner's registered
   * one — and «إلغاء الربط» is the only way out, because undoing it also
   * removes what it added to the owner's file. Never sent (`toPayloadProperty`).
   */
  /**
   * `name` is the owner's name as a row stores it (sent when the tenant's own
   * is blank); `displayName` is what the locked field shows — an estate as
   * «ورثة المرحوم …».
   */
  landlordLink?: { citizenId: string; name: string; displayName: string; referenceNumber: string | null };
  /**
   * The registered name of the citizen agreed to on this form, shown in the
   * locked name field. The tenant's own words stay in `landlordName`, so
   * withdrawing the agreement gives them back. Never sent.
   */
  landlordAgreedName?: string;
  propertyType?: PropertyType;
  neighborhood?: string;
  propertyNumber?: string;
  landType?: LandType;
  buildingName?: string;
  side?: string;
  tentLocation?: string;
  unitArea?: string;
  /** أرض only — أسهم out of the cadastre's standard 2400-share parcel. */
  shares?: string;
  sharedRights?: string[];
  /** منزل only — a مبنى states this per unit inside `units`. */
  unitStatus?: UnitStatus;
  units?: UnitDraft[];
}

/** A person's name parts, kept while the file is an institution — see `namesForKind`. */
export interface NamesBefore {
  firstName: string;
  middleName: string;
  lastName: string;
  /** The one line they were joined into; restored only while it still reads so. */
  joined: string;
}

export interface CitizenFormValues {
  /**
   * نوع الملف — a household living in the town, or «غير مقيم في البلدة». Decides
   * which questions the first two sections ask. Absent reads as a household,
   * which is what every draft and queued record from before it meant.
   */
  residence?: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: PropertyDraft[];
  /**
   * Why each saved card removed on this edit is going — the officer's answer
   * in the delete dialog. The census closes the flats a removed card claimed
   * with it: «سُجِّلت بالخطأ» drops them from the unit's history, «بيع أو نقل
   * ملكية» keeps the ownership, ending on its date. Only saved cards; a card
   * added and removed in the same sitting never reached the server.
   */
  removals?: Array<CardRemovalAnswer & { propertyId: string }>;
  /**
   * Fields the officer recorded as «غير مؤكَّد», keyed by dot-path.
   *
   * A Map rather than the array the wire uses, because every operation this
   * form performs on them is by path: is this field flagged, flag it, drop it
   * when its card is deleted. `flagsToArray` converts at the edge.
   */
  flags: Map<string, string>;
  /**
   * The server's «بانتظار التحقق» notes on this record, keyed by dot-path.
   *
   * Not part of what the form edits and never sent back — the server derives
   * these from its own cadastre on every write. They are carried in the form's
   * values only so the fields they name can say so while the officer is
   * looking at them.
   */
  unverified: Map<string, string>;
  /**
   * «سبب عام لنقص البيانات» — one reason for the whole visit (D12).
   *
   * Not a flag and not a replacement for them: the server copies it onto every
   * remaining gap as an overridable default, so a reviewer still gets a list of
   * named fields rather than one sentence attached to nothing. Undefined on an
   * ordinary save, which is the overwhelming majority of them.
   */
  blanketFlagReason?: string;
  /**
   * «ملاحظات» — free text the officer adds, asked for by no field.
   *
   * Deliberately *not* `blanketFlagReason`, which is the only free-text box
   * this form used to have and which officers were therefore using for this.
   * That one is a reason data is missing: it propagates onto every gap in the
   * record and its presence is part of what lands a registration at
   * «يتطلب مراجعة». Writing «الأسرة تنتقل نهاية الشهر» into it flags a clean
   * record for review. A note flags nothing.
   */
  notes?: string;
  /**
   * «تغيير الإقامة» — a real move applied on this form, not yet saved: the day
   * it took effect, sent as `movedOn`, and the reason the save's review starts
   * from. Absent on a correction, where only the answer changes.
   */
  residenceMove?: { movedOn: string; reason: string };
  /**
   * A person's name parts as they were when the file was switched to «جهة أو
   * وقف», so switching back restores them rather than re-splitting the joined
   * line (`namesForKind`). Never sent.
   */
  namesBefore?: NamesBefore;
}

/**
 * A brand new record — one blank property card, Lebanese by default.
 *
 * A factory rather than a shared constant. The old constant handed every form
 * that opened it the *same* `Map` and the same property array; nothing mutates
 * them today, because every update in this file copies before it writes, but
 * one `flags.set(...)` written in the ordinary imperative style would have
 * leaked one officer's «غير مؤكَّد» flags into the next blank form on that
 * device — and it would have looked completely reasonable in review.
 */
export function emptyCitizen(): CitizenFormValues {
  return {
    residence: 'RESIDENT',
    personal: { isLebanese: true },
    contact: { whatsappSameAsPhone: true, hasNoPhone: false },
    // Empty, not one blank card — a citizen who owns nothing and only rents
    // has no property to file, and that is the common case this form should
    // not stand in the way of. Staff add a card only for someone who owns.
    properties: [],
    flags: new Map(),
    unverified: new Map(),
  };
}

