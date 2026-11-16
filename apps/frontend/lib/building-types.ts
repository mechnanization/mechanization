'use client';

import {
  buildingTypeName,
  compareBuildingTypes,
  type BuildingTypeView,
  type StructureType,
} from '@mechanization/shared-schemas';
import { ApiRequestError, getBuildingTypes } from './api-client';
import { loadReference, offlineStorageAvailable, saveReference } from './offline-db';
import { useStaffQuery } from './use-staff-query';

/** The offline store's name for the list (`saveReference`). */
export const BUILDING_TYPES_REFERENCE = 'buildingTypes';

/** Where the list kept on the device is read from and written to; injectable for tests. */
export interface ReferenceCache<T> {
  load(): Promise<T | null>;
  save(data: T): Promise<void>;
}

/**
 * The building types, kept for an inspector with no network (0106): the
 * server's answer is saved on the device each time it arrives, and when the
 * server cannot be reached (`status` 0, the network) the last saved list is
 * answered instead. Any other refusal is the server's, and is thrown. A failed
 * save never fails the read.
 */
export async function readWithOfflineCopy<T>(fetchList: () => Promise<T>, cache: ReferenceCache<T>): Promise<T> {
  try {
    const list = await fetchList();
    await cache.save(list).catch(() => undefined);
    return list;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 0) {
      const kept = await cache.load().catch(() => null);
      if (kept) return kept;
    }
    throw error;
  }
}

function deviceCache(tenant: string): ReferenceCache<BuildingTypeView[]> {
  if (!offlineStorageAvailable()) return { load: async () => null, save: async () => undefined };
  return {
    load: async () => (await loadReference<BuildingTypeView[]>(tenant, BUILDING_TYPES_REFERENCE))?.data ?? null,
    save: (data) => saveReference(tenant, BUILDING_TYPES_REFERENCE, data),
  };
}

/**
 * «أنواع المباني» for a screen: the active types (the pickers, the map, the
 * reports), or every type for the screen that edits them. A reference read: kept
 * for the session and invalidated under `['building-types', tenant]` after a
 * write. The active list is also kept on the device for offline use.
 */
export function useBuildingTypes(
  tenant: string,
  base: string,
  token: string | null,
  options: { includeInactive?: boolean; errorMessage: string },
) {
  const includeInactive = Boolean(options.includeInactive);
  return useStaffQuery({
    queryKey: ['building-types', tenant, includeInactive ? 'all' : 'active'],
    queryFn: (accessToken, signal) =>
      includeInactive
        ? getBuildingTypes(tenant, accessToken, { includeInactive: true }, signal)
        : readWithOfflineCopy(() => getBuildingTypes(tenant, accessToken, {}, signal), deviceCache(tenant)),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: options.errorMessage,
  });
}

/**
 * The types to offer for a building, in the list's order: the active ones, and
 * the building's own type even when it was switched off since (an inactive type
 * stays on the buildings that have it, and the editor must still show it).
 */
export function typesToOffer(types: readonly BuildingTypeView[], current?: string | null): BuildingTypeView[] {
  return types.filter((type) => type.isActive || type.id === current).sort(compareBuildingTypes);
}

/** The system type of a structure, for a building filed before types existed or by an older client. */
export function systemTypeOf(types: readonly BuildingTypeView[], structureType: StructureType): BuildingTypeView | undefined {
  return types.find((type) => type.isSystem && type.structureType === structureType);
}

/** A building's type name, from its id or, before it has one, from its structure's system type. */
export function buildingTypeLabel(
  types: readonly BuildingTypeView[],
  building: { buildingTypeId?: string | null; structureType: StructureType },
  locale: string,
  fallback: string,
): string {
  const type =
    (building.buildingTypeId ? types.find((candidate) => candidate.id === building.buildingTypeId) : undefined) ??
    systemTypeOf(types, building.structureType);
  return type ? buildingTypeName(type, locale) : fallback;
}
