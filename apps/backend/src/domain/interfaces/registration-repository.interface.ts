import { PropertyEntry } from '../entities/property-entry.entity';
import { Registration } from '../entities/registration.entity';
import { CitizenIdentityInput } from './user-repository.interface';

export interface SubmitRegistrationInput {
  citizen: CitizenIdentityInput;
  citizenReference: string;
  registrationReference: string;
  properties: PropertyEntry[];
  /**
   * `REQUIRES_REVIEW` when anything on the record was left unestablished,
   * `PENDING` otherwise. Passed rather than derived here so the one place that
   * decides it is `statusForFlags`, next to the flags themselves.
   */
  status: 'PENDING' | 'REQUIRES_REVIEW';
  /** The «غير مؤكَّد» fields and their stated reasons, stored verbatim. */
  flaggedFields: ReadonlyArray<{ path: string; reason: string }>;
  /**
   * «سبب عام لنقص البيانات» — the one reason an officer gave for the whole
   * visit, when they gave one. Redundant with the per-field reasons above by
   * design: it is what says they came from a single statement rather than from
   * the same sentence typed thirty times. See `autoFlags`.
   */
  blanketFlagReason?: string;
  /** «ملاحظات» — free text, carrying no status consequence. */
  notes?: string;
  /** The staff user / field inspector who registered this record. */
  createdById?: string;
  /** The browser's own id for this submission, when it was filed offline. */
  clientSubmissionId?: string;
}

export interface SubmitRegistrationResult {
  registrationId: string;
  citizenId: string;
  referenceNumber: string;
  propertyIds: string[];
  /**
   * True when this call found the submission already stored under its
   * `clientSubmissionId` and returned that rather than writing a second one.
   * The sync queue reports it as "already synced" instead of "created".
   */
  deduplicated: boolean;
}

/*
 * `RegistrationListItem` was here — one row of a طلبات list, carrying `status`,
 * `rejectionReason`, `rejectedFields`, `citizenCanCorrect` and `revisitAt`.
 *
 * Both the lists it served are gone: the staff review queue (there is nothing
 * to adjudicate) and the citizen's «طلباتي» page (which now reads their
 * properties and fees through the profile projection instead). Its
 * status-free remnant had no caller left, so it goes rather than sitting here
 * as a shape nothing produces.
 */

export interface RegistrationRepository {
  /**
   * Citizen upsert + registration + property rows in one transaction. A partial
   * write is worse than a failed one: the clerk sees an error, retries, and
   * collides with the property rows their "failed" attempt already committed.
   */
  submit(input: SubmitRegistrationInput): Promise<SubmitRegistrationResult>;

  /** Rehydrates the aggregate, properties included. */
  findById(id: string): Promise<Registration | null>;

  /**
   * How many citizens are already registered on this parcel. Context for the
   * form, not a gate — co-registration on one cadastral number is normal.
   */
  countRegistrationsForParcel(propertyNumber: string): Promise<number>;
}
