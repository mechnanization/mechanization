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
  status: 'OPEN' | 'RESOLVED';
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
  }): Promise<Case>;

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
    },
  ): Promise<Case>;

  delete(id: string): Promise<void>;
}
