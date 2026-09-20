/**
 * حالات — field visits that could not become a citizen registration.
 * Like every other port here it takes no tenant argument — the implementation
 * reads the tenant-scoped client out of the request scope.
 */

export interface Case {
  id: string;
  notes: string;
  propertyNumber: string | null;
  neighborhood: string | null;
  propertyType: string | null;
  buildingName: string | null;
  floor: string | null;
  side: string | null;
  landType: string | null;
  tentLocation: string | null;
  status: 'OPEN' | 'SCHEDULED' | 'RESOLVED';
  /** Why the visit did not complete. `GENERAL_NOTE` for everything logged
   *  before the column existed — see migration 0030. */
  caseType: string;
  /**
   * The resolved form of `buildingName`/`floor` above, once the case can be
   * attached to actual rows. Both stay: the free text is what the officer wrote
   * at the door, and on a parcel with no surveyed buildings it is all there is.
   */
  buildingId: string | null;
  buildingCode: string | null;
  unitId: string | null;
  unitCode: string | null;
  /** The damage reading that prompted this case, if one did. A reference, not
   *  ownership — resolving the case says nothing about the damage (D6). */
  damageAssessmentId: string | null;
  /** When someone has agreed to go back. Meaningful under `SCHEDULED`. */
  scheduledRevisitAt: Date | null;
  /** The citizen whose registration resolved this case, if any — see the model comment. */
  resolvedCitizenId: string | null;
  resolvedCitizenName: string | null;
  resolvedAt: Date | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseListFilter {
  propertyNumber?: string;
  status?: string;
  caseType?: string;
  buildingId?: string;
  unitId?: string;
  /**
   * When the case was opened, inclusive at both ends.
   *
   * On `createdAt` rather than `scheduledRevisitAt`: «what came in last week»
   * is the question the list is read with, and a revisit date is set on only
   * some types. Filtering by the date a case was raised is the one that means
   * the same thing for every row.
   */
  from?: Date;
  to?: Date;
}

/** The columns a case may carry beyond what the doorstep form collects. */
export interface CaseCensusLinks {
  caseType?: string;
  buildingId?: string | null;
  unitId?: string | null;
  damageAssessmentId?: string | null;
  scheduledRevisitAt?: Date | null;
}

export interface CaseRepository {
  findAll(filter?: CaseListFilter): Promise<Case[]>;

  findById(id: string): Promise<Case | null>;

  create(input: {
    notes: string;
    propertyNumber?: string;
    neighborhood?: string;
    propertyType?: string;
    buildingName?: string;
    floor?: string;
    side?: string;
    landType?: string;
    tentLocation?: string;
    createdById?: string;
  } & CaseCensusLinks): Promise<Case>;

  /**
   * Closes every case still open against a unit, because somebody has just been
   * recorded as living in it. Returns how many — see `CasesService.resolveForUnit`.
   */
  resolveOpenForUnit(unitId: string, citizenId: string): Promise<number>;

  /**
   * Closes the «شاغرة قيد التحقق» cases on a unit whose vacancy has just been
   * confirmed. Narrowed to that one type, and carries no citizen — see the
   * implementation. Returns how many.
   */
  resolveVacancyCasesForUnit(unitId: string): Promise<number>;

  update(
    id: string,
    input: {
      notes?: string;
      propertyNumber?: string | null;
      neighborhood?: string | null;
      propertyType?: string;
      buildingName?: string | null;
      floor?: string | null;
      side?: string | null;
      landType?: string;
      tentLocation?: string | null;
      status?: string;
      resolvedCitizenId?: string | null;
      resolvedAt?: Date | null;
    } & CaseCensusLinks,
  ): Promise<Case>;

  delete(id: string): Promise<void>;
}
