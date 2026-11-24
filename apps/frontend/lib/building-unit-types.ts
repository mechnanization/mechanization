import { UNIT_TYPE, isStructuralUnitType } from '@mechanization/shared-schemas';

/**
 * The unit types a مبنى can actually contain.
 *
 * Derived from `UNIT_TYPE` rather than retyped, which is the whole point: this
 * list said شقة / عيادة / محل for as long as it was a literal, and went on
 * saying it after the taxonomy gained مكتب and مستودع — so a municipality whose
 * schedule of fees charges a warehouse differently from a shop had no way to
 * record one, and two values sat in the database and in the fee-target list
 * reachable from nothing. Subtracting from the enum keeps this correct the next
 * time it widens.
 */
export const BUILDING_UNIT_TYPES = UNIT_TYPE.filter(
  (type) => type !== 'INDEPENDENT_HOUSE' && !isStructuralUnitType(type),
);
