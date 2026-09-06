import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  cadastreFlags,
  isUnestablished,
  statusForFlags,
  type AdminCitizenSubmission,
  type CitizenRecordStatus,
  type FieldFlag,
} from '@mechanization/shared-schemas';
import { PropertyEntry, PropertyType } from '../../../domain/entities/property-entry.entity';
import { Registration } from '../../../domain/entities/registration.entity';
import { ReferenceNumber } from '../../../domain/value-objects/reference-number.vo';
import {
  PARCEL_REPOSITORY,
  REGISTRATION_REPOSITORY,
} from '../../../domain/interfaces/base-repository.interface';
import type {
  ParcelLocation,
  ParcelRepository,
} from '../../../domain/interfaces/parcel-repository.interface';
import { RegistrationRepository } from '../../../domain/interfaces/registration-repository.interface';
import { ConflictError } from '../../common/exceptions';
import { TenantService } from '../tenant/tenant.service';

/** How many alternative parcel numbers to offer when a number is not found. */
const SUGGESTION_LIMIT = 8;

export interface PropertyNumberCheck {
  propertyNumber: string;
  /**
   * Whether the number exists in the municipality's cadastre. `null` when the
   * municipality has not imported one, i.e. the question does not apply.
   *
   * This is the only thing on this response that can be *wrong* — everything
   * else is context.
   */
  inCadastre: boolean | null;
  location: { latitude: number; longitude: number; approximate: boolean } | null;
  /** Nearby real parcel numbers, offered only when the typed one is unknown. */
  suggestions: string[];
  /**
   * How many citizens have already registered this parcel. Reported so the
   * form can say "your neighbours are here too" — never to refuse the entry.
   * An apartment building is one cadastral number shared by everyone in it.
   */
  registeredCount: number;
}

export interface SubmitResult {
  registrationId: string;
  citizenId: string;
  referenceNumber: string;
  propertyCount: number;
  propertyIds: string[];
  status: CitizenRecordStatus;
  /** True when this submission had already been delivered — see `clientSubmissionId`. */
  deduplicated: boolean;
}

/**
 * The flagged fields belonging to one property card, as bare field names.
 *
 * `properties.2.landlordPhone` → `landlordPhone` for card 2, and nothing for
 * any other card. The domain entity validates one card at a time and has no
 * idea which index it is, so the index is resolved here, once, rather than
 * teaching `PropertyEntry` about the shape of the form above it.
 *
 * `UNVERIFIED` flags are not waivers and are filtered out. The field they name
 * holds a real value that must still satisfy every rule about what a value of
 * that kind may look like — a رقم العقار missing from the cadastre is still
 * required to be a رقم العقار. Waiving it here would let the one flag the
 * server raises by itself quietly disable the validation on the field it is
 * about.
 */
export function unestablishedOnCard(
  flags: readonly FieldFlag[],
  index: number,
): ReadonlySet<string> {
  const prefix = `properties.${index}.`;
  return new Set(
    flags
      .filter((flag) => isUnestablished(flag) && flag.path.startsWith(prefix))
      .map((flag) => flag.path.slice(prefix.length)),
  );
}

/**
 * Writing a citizen's property filing, and the cadastre lookup behind it.
 *
 * The review half of this service — `changeStatus`, `getCorrectionContext`,
 * `applyCorrection`, `listForReview` — is gone with the طلب workflow it
 * served. What is left is the write path (`submit`, still the single place a
 * citizen + registration + property rows are created, now driven by
 * `CitizensService`) and the رقم العقار check the staff entry form calls on
 * every keystroke.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(REGISTRATION_REPOSITORY) private readonly registrations: RegistrationRepository,
    @Inject(PARCEL_REPOSITORY) private readonly parcels: ParcelRepository,
    private readonly tenants: TenantService,
    private readonly events: EventEmitter2,
  ) {}

  async submit(input: {
    tenantSlug: string;
    payload: AdminCitizenSubmission;
    createdById?: string;
  }): Promise<SubmitResult> {
    const tenant = await this.tenants.resolve(input.tenantSlug);

    /**
     * Coordinates come from the municipality's cadastre, not from the citizen.
     *
     * The survey office already knows where parcel 1553 is, to better precision
     * than anyone can achieve by dragging a pin on a phone — so the wizard no
     * longer asks. رقم العقار is the location.
     *
     * A card whose number was never established is simply not looked up. It
     * gets no coordinates and appears nowhere on the map until someone fills
     * the number in — which is the honest outcome, and better than the
     * alternative of asking the cadastre about an empty string.
     */
    const { found: cadastre, missing } = await this.resolveParcels(
      input.payload.properties
        .map((entry) => entry.propertyNumber)
        .filter((number): number is string => Boolean(number)),
    );

    /*
      The officer's flags, plus whatever the cadastre had to say.

      Derived here rather than trusted from the payload, and re-derived on every
      write: a record queued three days ago carries the verdict of a cadastre
      that may since have gained the very parcel it was missing, and the right
      answer is the one that is true now.
    */
    const flags: FieldFlag[] = [
      ...input.payload.flags,
      ...cadastreFlags(input.payload.properties, missing, input.payload.flags),
    ];

    // Zod validated the wire format at the controller. These construct domain
    // objects, which is where the taxonomy rules actually live — so a seed
    // script or a future CSV import gets the same guarantees as an HTTP request.
    // The waiver set is per card and never wider than the fields the officer
    // actually named.
    const properties = input.payload.properties.map((entry, index) => {
      const parcel = entry.propertyNumber
        ? cadastre.get(entry.propertyNumber.trim())
        : undefined;
      return PropertyEntry.create(
        {
          ...(entry as unknown as Record<string, unknown>),
          latitude: parcel?.latitude ?? null,
          longitude: parcel?.longitude ?? null,
        } as never,
        unestablishedOnCard(flags, index),
      );
    });

    for (const property of properties) {
      if (!tenant.allowsPropertyType(property.propertyType as PropertyType)) {
        throw new ConflictError(
          `هذه البلدية لا تستقبل حالياً تسجيل هذا النوع من العقارات (${property.propertyType})`,
        );
      }
    }

    const citizenReference = ReferenceNumber.generate(tenant.referencePrefix).value;
    const registrationReference = ReferenceNumber.generate(tenant.referencePrefix).value;

    // Constructs the aggregate — rejects an empty submission and duplicate
    // property numbers within it — and records the submitted event.
    const registration = Registration.create({
      id: 'pending',
      citizenId: 'pending',
      referenceNumber: registrationReference,
      properties,
    });

    const result = await this.registrations.submit({
      citizen: {
        phone: input.payload.contact.phone,
        whatsapp: input.payload.contact.whatsapp ?? input.payload.contact.phone,
        firstName: input.payload.personal.firstName,
        middleName: input.payload.personal.middleName || undefined,
        lastName: input.payload.personal.lastName,
        gender: input.payload.personal.gender,
        nationality: input.payload.personal.nationality,
        isLebanese: input.payload.personal.isLebanese,
        residencyNumber: input.payload.personal.residencyNumber || undefined,
        residentStatus: input.payload.personal.residentStatus,
        identityDocType: input.payload.personal.identityDocType,
        /**
         * A Lebanese citizen always has this. A non-Lebanese one is only
         * required to supply *one* of a passport number or a رقم إقامة
         * (`personalDetailsSchema`'s refine enforces that), so this falls
         * back to whichever the person actually gave — the identity lookup
         * key needs one real value either way, and the fallback never
         * triggers for a payload that passed validation.
         *
         * `undefined` is now a third outcome, and only reachable when the
         * officer flagged the document itself: the person is registered
         * without an identity key, which the repository handles by inserting
         * rather than upserting. See the note there.
         */
        identityDocNumber:
          input.payload.personal.identityDocNumber ||
          input.payload.personal.residencyNumber ||
          undefined,
        civilRecordNumber: input.payload.personal.civilRecordNumber || undefined,
        totalRegisteredMembers:
          input.payload.contact.totalRegisteredMembers ??
          input.payload.contact.actualHouseholdMembers,
        actualHouseholdMembers: input.payload.contact.actualHouseholdMembers,
        maritalStatus: input.payload.contact.maritalStatus,
        bloodType: input.payload.personal.bloodType,
      },
      citizenReference,
      registrationReference,
      properties,
      status: statusForFlags(flags),
      flaggedFields: flags,
      createdById: input.createdById,
      clientSubmissionId: input.payload.clientSubmissionId,
    });

    // Published only after the transaction committed — nothing is announced
    // that did not persist, and nothing is announced twice: a re-delivered
    // offline submission wrote nothing, so there is no new fact to publish.
    registration.pullEvents();
    if (!result.deduplicated) {
      this.events.emit('registration.submitted', {
        tenantSlug: input.tenantSlug,
        registrationId: result.registrationId,
        citizenId: result.citizenId,
        referenceNumber: result.referenceNumber,
        propertyCount: properties.length,
      });
    }

    return {
      registrationId: result.registrationId,
      citizenId: result.citizenId,
      referenceNumber: result.referenceNumber,
      propertyCount: properties.length,
      propertyIds: result.propertyIds,
      status: statusForFlags(flags),
      deduplicated: result.deduplicated,
    };
  }

  /**
   * Looks every submitted رقم العقار up in the municipality's cadastre.
   *
   * Reports rather than refuses. This used to throw, and the rejection was
   * wrong in both directions: it treated "the survey office has not imported
   * this parcel yet" as a typo, and it did so at the one moment nobody could
   * act on it — a record filed with no signal was queued, promised to the
   * officer as sent, and then failed on delivery hours later in a settlement
   * they had already left. `cadastreFlags` turns the same finding into an
   * `UNVERIFIED` flag: the number is stored as read, the record is held at
   * «يتطلب مراجعة», and the typo is caught by the person who was always going
   * to have to catch it — with the household's data in front of them.
   *
   * A municipality that has not imported a cadastre has nothing to check
   * against, so nothing is reported missing.
   */
  private async resolveParcels(
    propertyNumbers: readonly string[],
  ): Promise<{ found: Map<string, ParcelLocation>; missing: Set<string> }> {
    const found = await this.parcels.findManyByNumber(propertyNumbers);

    const unresolved = propertyNumbers
      .map((number) => number.trim())
      .filter((number) => !found.has(number));

    // Only asked when something is missing: with every number resolved there is
    // nothing for the count to decide.
    const hasCadastre = unresolved.length > 0 && (await this.parcels.count()) > 0;

    return { found, missing: new Set(hasCadastre ? unresolved : []) };
  }

  /**
   * Live check while the citizen types رقم العقار.
   *
   * Answers one question that can fail — is this a real parcel in this
   * municipality — and one that cannot: how many neighbours are already
   * registered on it. The second used to be a gate, which meant the second
   * resident of an apartment building was told their own address was taken.
   */
  async checkPropertyNumber(propertyNumber: string): Promise<PropertyNumberCheck> {
    const trimmed = propertyNumber.trim();

    const [registeredCount, parcel, cadastreSize] = await Promise.all([
      this.registrations.countRegistrationsForParcel(trimmed),
      this.parcels.findByNumber(trimmed),
      this.parcels.count(),
    ]);

    const hasCadastre = cadastreSize > 0;

    return {
      propertyNumber: trimmed,
      inCadastre: hasCadastre ? parcel !== null : null,
      location: parcel
        ? {
            latitude: parcel.latitude,
            longitude: parcel.longitude,
            approximate: parcel.approximate,
          }
        : null,
      suggestions:
        hasCadastre && !parcel ? await this.parcels.suggest(trimmed, SUGGESTION_LIMIT) : [],
      registeredCount,
    };
  }

}
