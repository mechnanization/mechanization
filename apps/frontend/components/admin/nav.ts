import {
  ArrowLeftRight,
  BadgeDollarSign,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  Layers,
  Map as MapIcon,
  Receipt,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * The admin section list, and the rules for reading it.
 *
 * Lifted out of `AdminSidebar` because it is no longer only the sidebar's
 * business: the header derives the breadcrumb and the page title from the same
 * list, the mobile drawer renders the same rows, and the command palette
 * searches them. Three copies of "which section is this route in" is three
 * chances for the highlighted row and the breadcrumb to disagree.
 */

export interface NavItem {
  /** Appended to the tenant's admin base path. */
  path: string;
  label: string;
  labelEn?: string;
  icon: LucideIcon;
  /** Omitted = every staff role can see it. */
  roles?: string[];
  /** Extra words the command palette matches on, beyond the label. */
  keywords?: string[];
}

export interface NavGroup {
  /** Shown as a small caps heading; hidden when the rail is folded. */
  label: string;
  labelEn?: string;
  /** Omitted = every staff role can see it. */
  roles?: string[];
  items: NavItem[];
}

/**
 * Three groups, in the order a clerk's day runs: the register and the money it
 * generates, then the land those records describe, then the portal's own
 * administration.
 *
 * A flat list of ten was past scannable — «القطاعات» and «الموظفون» read as
 * equally likely neighbours of «المواطنون» when they belong to different jobs
 * entirely.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'السجل',
    labelEn: 'Registry',
    items: [
      // The register's overview, so the register's roles — see DashboardController.
      {
        path: '/dashboard',
        label: 'لوحة التحكم',
        labelEn: 'Dashboard',
        icon: LayoutDashboard,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR'],
        keywords: ['مؤشرات', 'تحليلات', 'إحصاءات', 'dashboard', 'analytics'],
      },
      {
        path: '/inspector/profile',
        label: 'أرباحي والمسح الميداني',
        labelEn: 'Inspector Earnings',
        icon: BadgeDollarSign,
        keywords: ['أرباح', 'عمولة', 'مفتش', 'مسح', 'عقارات', 'inspector', 'earnings'],
      },
      // Directly under the dashboard: the dashboard reports on the register,
      // and this is the register itself — one row per person.
      {
        path: '/citizens',
        label: 'المواطنون',
        labelEn: 'Citizens',
        icon: Users,
        keywords: ['سجل', 'مواطن', 'عقار', 'استيراد', 'citizens', 'registry'],
      },
      // A visit that didn't produce a citizen — nobody home, gate locked —
      // sits next to the registry it feeds rather than under land/map, since
      // what it records is "who to go back to", not a parcel's own facts.
      {
        path: '/cases',
        label: 'الحالات',
        labelEn: 'Cases',
        icon: ClipboardList,
        keywords: ['زيارة', 'لا أحد في المنزل', 'متابعة', 'cases', 'follow-up', 'visit'],
      },
      // Next to the registry rather than under settings: a fee is issued
      // against the citizens in it, not configured in isolation.
      {
        path: '/fees',
        label: 'الرسوم والمدفوعات',
        labelEn: 'Fees & Billing',
        icon: Receipt,
        keywords: ['رسم', 'مطالبة', 'فاتورة', 'دفع', 'fees', 'billing'],
      },
      // Read-only: the ledger above answers "who owes what", this answers
      // "what has been paid". An auditor lives here.
      {
        path: '/payments',
        label: 'سجل العمليات',
        labelEn: 'Payment Operations',
        icon: ArrowLeftRight,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT'],
        keywords: ['قبض', 'إيصال', 'محصّل', 'نقد', 'payments', 'transactions'],
      },
    ],
  },
  {
    label: 'الأرض',
    labelEn: 'Land & Map',
    items: [
      {
        path: '/map',
        label: 'الخريطة',
        labelEn: 'Cadastral Map',
        icon: MapIcon,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER'],
        keywords: ['عقارات', 'مواقع', 'مسح', 'map', 'cadastre'],
      },
      {
        path: '/zones',
        label: 'القطاعات',
        labelEn: 'Zones',
        icon: Layers,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER'],
        keywords: ['قطاع', 'منطقة', 'حدود', 'zones', 'districts'],
      },
    ],
  },
  {
    label: 'النظام',
    labelEn: 'System',
    items: [
      {
        path: '/audit',
        label: 'سجل النشاطات',
        labelEn: 'Audit Log',
        icon: ShieldCheck,
        roles: ['SUPER_ADMIN'],
        keywords: ['تدقيق', 'تاريخ', 'تغييرات', 'audit', 'logs'],
      },
      {
        path: '/settings',
        label: 'إعدادات البلدية',
        labelEn: 'Settings',
        icon: Settings,
        roles: ['SUPER_ADMIN'],
        keywords: ['ويش', 'واتساب', 'عنوان', 'دوام', 'settings', 'config'],
      },
      {
        path: '/staff',
        label: 'الموظفون',
        labelEn: 'Staff Management',
        icon: UsersRound,
        roles: ['SUPER_ADMIN'],
        keywords: ['موظف', 'صلاحيات', 'حساب', 'staff', 'users'],
      },
      {
        path: '/account',
        label: 'أمان الحساب',
        labelEn: 'Account Security',
        icon: KeyRound,
        keywords: ['كلمة المرور', 'أمان', 'حسابي', 'مصادقة', '2fa', 'password', 'security', 'account'],
      },
    ],
  },
];

/** The groups this role may see, with empty groups dropped entirely. */
export function visibleGroups(role: string | undefined): NavGroup[] {
  return NAV_GROUPS
    .filter((group) => !group.roles || (role && group.roles.includes(role)))
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.roles || (role && item.roles.includes(role))),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Where this role lands when it has not asked for anywhere in particular.
 *
 * Derived from `visibleGroups` rather than kept as a second list, so a role
 * added to the nav gets a landing page without anyone remembering to add one:
 * the first row this role can see, in the order the sidebar shows them.
 *
 * That matters because `/dashboard` is not universal. It is restricted to
 * SUPER_ADMIN, AUDITOR and FIELD_INSPECTOR, and the nav already anticipates
 * COLLECTOR, ACCOUNTANT and ADMINISTRATIVE_OFFICER — none of which may open it.
 * Sending those roles to `/dashboard` would greet them with a 403 on the first
 * screen they ever see.
 *
 * `/citizens` is the practical floor: it carries no `roles` restriction, so
 * every staff role can see it and this never returns nothing. The `??` is for
 * a role the nav has never heard of, where landing somewhere harmless beats
 * landing nowhere.
 */
export function defaultPathFor(role: string | undefined): string {
  if (role === 'FIELD_INSPECTOR') {
    return '/inspector/profile';
  }
  const groups = visibleGroups(role);
  return groups[0]?.items[0]?.path ?? '/citizens';
}

/**
 * Whether this role may open a given admin path — the redirect's other half.
 *
 * Three outcomes collapse into two, and getting that collapse right is the
 * whole subtlety:
 *
 *   • the admin base itself → allowed, because the index page's job is to
 *     redirect and it cannot do that if it never renders;
 *   • a path under a section this role can see → allowed;
 *   • a path under a section it cannot → refused, and the caller sends them to
 *     their own landing page;
 *   • **a path under no section at all** → allowed, deliberately.
 *
 * That last case is the one worth stating. A URL matching no nav row is not a
 * permission problem, it is a 404 — and the admin area has a page for that.
 * Refusing it here would redirect every mistyped address silently to the
 * dashboard, so a stale link would look like it worked and quietly took the
 * reader somewhere else.
 */
export function canAccessPath(pathname: string, base: string, role: string | undefined): boolean {
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  if (relative === '' || relative === '/') return true;

  // Matched against every section, ignoring role: this answers "is there a
  // page here at all", which is a different question from "may they see it".
  const known = NAV_GROUPS.flatMap((group) => group.items).some((item) => {
    const href = `${base}${item.path}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  });
  if (!known) return true;

  return Boolean(activeNavItem(pathname, base, role));
}

/**
 * Which nav row a pathname belongs to — **longest match wins**.
 *
 * A plain `startsWith` lights up two rows wherever one route is a prefix of
 * another, and `/citizens` became such a prefix the moment `/citizens/:id`
 * existed. Matching on the longest candidate keeps a detail page attributed to
 * its own section rather than to whichever prefix was declared first.
 *
 * Takes the full pathname and the tenant's admin base so callers do not each
 * rebuild `/{tenant}/{locale}/{adminPath}` and get the trailing slash wrong.
 */
export function activeNavItem(
  pathname: string | null,
  base: string,
  role: string | undefined,
): NavItem | undefined {
  if (!pathname) return undefined;
  const candidates = visibleGroups(role)
    .flatMap((group) => group.items)
    .filter((item) => {
      const href = `${base}${item.path}`;
      return pathname === href || pathname.startsWith(`${href}/`);
    })
    .sort((a, b) => b.path.length - a.path.length);
  return candidates[0];
}

export function localizedLabel(item: NavItem, locale: string = 'ar'): string {
  return locale === 'en' && item.labelEn ? item.labelEn : item.label;
}

export function localizedGroupLabel(group: NavGroup, locale: string = 'ar'): string {
  return locale === 'en' && group.labelEn ? group.labelEn : group.label;
}
