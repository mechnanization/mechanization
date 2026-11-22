'use client';

import {
  UNIT_TYPE,
  compareUnitTypes,
  isStructuralUnitType,
  knownUnitFigure,
  unitTypeName,
  type UnitType,
  type UnitFigure,
  type UnitTypeView,
} from '@mechanization/shared-schemas';
import { getUnitTypes } from './api-client';
import { readWithOfflineCopy, type ReferenceCache } from './building-types';
import { loadReference, offlineStorageAvailable, saveReference } from './offline-db';
import { useStaffQuery } from './use-staff-query';

/** The offline store's name for the list (`saveReference`). */
export const UNIT_TYPES_REFERENCE = 'unitTypes';

function deviceCache(tenant: string): ReferenceCache<UnitTypeView[]> {
  if (!offlineStorageAvailable()) return { load: async () => null, save: async () => undefined };
  return {
    load: async () => (await loadReference<UnitTypeView[]>(tenant, UNIT_TYPES_REFERENCE))?.data ?? null,
    save: (data) => saveReference(tenant, UNIT_TYPES_REFERENCE, data),
  };
}

/**
 * «أنواع الوحدات» for a screen: the active types (the pickers), or every type
 * for the screen that edits them. A reference read: kept for the session and
 * invalidated under `['unit-types', tenant]` after a write. The active list is
 * also kept on the device for an inspector with no network, the way the
 * building types are (0106).
 */
export function useUnitTypes(
  tenant: string,
  base: string,
  token: string | null,
  options: { includeInactive?: boolean; errorMessage: string },
) {
  const includeInactive = Boolean(options.includeInactive);
  return useStaffQuery({
    queryKey: ['unit-types', tenant, includeInactive ? 'all' : 'active'],
    queryFn: (accessToken, signal) =>
      includeInactive
        ? getUnitTypes(tenant, accessToken, { includeInactive: true }, signal)
        : readWithOfflineCopy(() => getUnitTypes(tenant, accessToken, {}, signal), deviceCache(tenant)),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: options.errorMessage,
  });
}

/**
 * One choice in a unit-type picker. `value` is what the select holds: a type's
 * id, or — for a floor block, which has no type — the structural `UnitType`
 * itself. `unitType` is always the base the server will bill it as, so a host
 * that cannot reach the list still sends something it understands.
 */
export interface UnitTypeOption {
  value: string;
  label: string;
  unitType: UnitType;
  /** Absent on a floor block, and on every option while the list is not loaded. */
  unitTypeId?: string;
}

/** What a picker reads off a unit, or off a draft of one. */
export interface TypedUnitFields {
  unitType: UnitType;
  unitTypeId?: string | null;
}

/**
 * The options a picker offers, in this order: the municipality's active types
 * (system first, then its own), then the structural floor types when the host
 * draws them, so a mis-tap on «طابق أعمدة» stays far from the common choice.
 *
 * - `types` empty — the list is still loading, or an offline device never
 *   fetched it — falls back to the base values in `fallback`, each sent with no
 *   id; the server files such a unit under its base's system type.
 * - `current` keeps the type a unit already has even when it was switched off
 *   since, so the select can show it.
 * - `omitBases` takes types out by base (the matrix does not offer «منزل مستقل»
 *   inside a building, unless it is the only block).
 */
export function unitTypeOptions(input: {
  types: readonly UnitTypeView[];
  locale: string;
  unitTypeLabels: Readonly<Record<UnitType, string>>;
  /** The bases offered when there is no list to read. */
  fallback: readonly UnitType[];
  omitBases?: readonly UnitType[];
  current?: { unitTypeId?: string | null } | null;
  /** Append `PILOTIS` and `EMPTY_FLOOR`, as the matrix's grid does. */
  withStructural?: boolean;
}): UnitTypeOption[] {
  const omit = new Set<string>(input.omitBases ?? []);
  const premises: UnitTypeOption[] =
    input.types.length > 0
      ? input.types
          .filter((type) => (type.isActive || type.id === input.current?.unitTypeId) && !omit.has(type.baseType))
          .sort(compareUnitTypes)
          .map((type) => ({ value: type.id, label: unitTypeName(type, input.locale), unitType: type.baseType, unitTypeId: type.id }))
      : input.fallback
          .filter((base) => !isStructuralUnitType(base) && !omit.has(base))
          .map((base) => ({ value: base, label: input.unitTypeLabels[base], unitType: base }));
  const structural: UnitTypeOption[] = input.withStructural
    ? UNIT_TYPE.filter(isStructuralUnitType).map((base) => ({ value: base, label: input.unitTypeLabels[base], unitType: base }))
    : [];
  return [...premises, ...structural];
}

/** The option a unit sits on: its type when the list offers it, else its base value. */
export function optionValueOf(unit: TypedUnitFields, options: readonly UnitTypeOption[]): string {
  if (unit.unitTypeId && options.some((option) => option.value === unit.unitTypeId)) return unit.unitTypeId;
  // No id, or one the list no longer carries: the first option of its base, which is its system type.
  return options.find((option) => option.unitType === unit.unitType)?.value ?? unit.unitType;
}

/** The base and the id a chosen option stands for. */
export function chosenType(value: string, options: readonly UnitTypeOption[]): { unitType: UnitType; unitTypeId?: string } | null {
  const option = options.find((candidate) => candidate.value === value);
  if (!option) return null;
  return option.unitTypeId ? { unitType: option.unitType, unitTypeId: option.unitTypeId } : { unitType: option.unitType };
}

/**
 * A unit's type name for a tile or a heading: its type's name in the page's
 * language when it has one the list carries, else its base's label.
 */
export function unitTypeLabel(
  types: readonly UnitTypeView[],
  unit: TypedUnitFields,
  locale: string,
  unitTypeLabels: Readonly<Record<UnitType, string>>,
): string {
  const type = unit.unitTypeId ? types.find((candidate) => candidate.id === unit.unitTypeId) : undefined;
  return type ? unitTypeName(type, locale) : unitTypeLabels[unit.unitType];
}

/**
 * The drawing of each unit type that has one, by the type's id — what
 * `BuildingElevation` reads to draw a mosque or a pharmacy as itself (0111). A
 * type with no key, or a key this build has no drawing for, is left out and its
 * units are drawn with their base's front.
 */
export function figuresByType(types: readonly UnitTypeView[]): Map<string, UnitFigure> {
  const figures = new Map<string, UnitFigure>();
  for (const type of types) {
    const figure = knownUnitFigure(type.figureKey);
    if (figure) figures.set(type.id, figure);
  }
  return figures;
}
