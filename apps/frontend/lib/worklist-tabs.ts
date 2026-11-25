/**
 * «قوائم العمل الميداني» (NAV-04): the two worklists as tabs of one page, and
 * what each keeps in the URL.
 *
 * In a plain module, not in the tab components, because the two old addresses
 * (`buildings/unsurveyed`, `buildings/reinspections`) are server redirects that
 * need the names, and a server page cannot read a constant out of a
 * `'use client'` file.
 */

/** `?tab=`: the first is where the old `/buildings/unsurveyed` landed. */
export const WORKLIST_TABS = ['unsurveyed', 'reinspections'] as const;
export type WorklistTab = (typeof WORKLIST_TABS)[number];

/**
 * «بانتظار إعادة الكشف» keeps its page, page size and officer filter under names
 * of its own, so «وحدات غير ممسوحة» can keep `?page=`, `?limit=` and `?owner=`
 * and each tab finds its state where it left it.
 */
export const REINSPECTIONS_OWNER_KEY = 'reinspectOwner';
export const REINSPECTIONS_PAGE_KEY = 'reinspectPage';
export const REINSPECTIONS_SIZE_KEY = 'reinspectLimit';
