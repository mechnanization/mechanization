import { Building2, ClipboardCheck, MapPin } from 'lucide-react';

/*
  The building editor's constants and its three steps (GOD-21, phase 1), moved out
  of `building-editor.tsx` with their notes unchanged.
*/

export const LOOKUP_DEBOUNCE_MS = 350;

/**
 * What a منزل becomes when the officer says it is a building.
 *
 * Named rather than inlined because two things have to agree about it — the
 * structure type written to the shell, and the unit type
 * `defaultUnitTypeFor` derives for every block being re-typed — and they are
 * several lines apart.
 *
 * «بناية سكنية» and not «متعدد الاستعمالات»: the officer has told us there is
 * more than one dwelling and nothing more, and a residential block is what
 * that is nineteen times out of twenty. Every other type is one tap away on
 * the step they were just on.
 */
export const PROMOTED_STRUCTURE_TYPE = 'RESIDENTIAL_BUILDING' as const;
/** The grid's own physical ceiling (20×20) — a defensive assertion, not a
 *  real user-facing limit, since the grid itself can never produce more. */
export const MAX_GRID_UNITS = 400;

/**
 * Metres under which an existing structure is shown as «قريبة جداً».
 *
 * Neighbouring buildings in this town genuinely stand 2–7 m apart (parcel 45
 * has four real structures that close), so this is not a line past which a
 * second record is refused — it is where the distance stops being a detail and
 * becomes the first thing on the row. Parcel 56's duplicates were 3.6 m and
 * 4.1 m from the original.
 */
export const NEAR_DUPLICATE_METRES = 15;

/** The same four-character floor every other reason in the app has. */
export { MIN_DUPLICATE_REASON } from '@/lib/building-editor-rules';

export const STEPS = [
  /*
    Renamed from «موقع المدخل», because the step no longer only asks for a pin.

    It now runs sector → map → رقم العقار → فرز → shared parcels, which is the
    order an officer actually has the answers in: they know where they are
    standing long before they know the cadastral number of the ground under
    them. The old order asked for the number first and then offered the map,
    which is the one sequence in which the map cannot help.
  */
  { en: 'Location & Parcel', ar: 'الموقع والعقار', icon: MapPin },
  { en: 'Facility Information', ar: 'معلومات المنشأة', icon: Building2 },
  { en: 'Unit Matrix', ar: 'مصفوفة الوحدات', icon: ClipboardCheck },
] as const;
