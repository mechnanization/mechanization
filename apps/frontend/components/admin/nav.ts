import {
  ArrowLeftRight,
  BadgeDollarSign,
  Building2,
  ClipboardCheck,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  Layers,
  Link2,
  Map as MapIcon,
  Receipt,
  Settings,
  ShieldCheck,
  UserPlus,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { STAFF_ROLE } from '@mechanization/shared-schemas';

/**
 * Every staff role there is — spelled out rather than left implicit.
 *
 * `roles` used to be optional, and an omitted list meant "everyone". That reads
 * as a decision but is indistinguishable from an oversight, and the two had
 * already diverged: «الرسوم والمدفوعات» carried no list while
 * `FeesController` refuses `FIELD_INSPECTOR` on every endpoint the page calls,
 * so an inspector saw the row, opened it and got a 403 from a link the portal
 * had offered them.
 *
 * Now every row states who may see it. A row that genuinely is universal says
 * so with this constant, which also means a role added to `STAFF_ROLE` later
 * has to be placed deliberately on each row instead of silently inheriting the
 * whole sidebar.
 */
const EVERY_STAFF_ROLE: readonly string[] = STAFF_ROLE;

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
  /**
   * Who may see this row. Required — see `EVERY_STAFF_ROLE` for why a row that
   * is open to everybody says so rather than leaving it off.
   */
  roles: readonly string[];
  /** Extra words the command palette matches on, beyond the label. */
  keywords?: string[];
}

export interface NavGroup {
  /**
   * Shown as a small caps heading; hidden when the rail is folded.
   *
   * Omitted for the leading group, whose rows are where a role lands rather
   * than a section of the portal. A heading there would have to be named
   * something like «عام», which says nothing, and it would be foldable — and a
   * clerk who folds away the row they land on every morning has hidden their
   * own front door.
   */
  label?: string;
  labelEn?: string;
  /** Omitted = the group itself gates nothing; its rows still do. */
  roles?: readonly string[];
  items: NavItem[];
}

/**
 * An unlabelled landing pair, then four groups in the order a clerk's day runs:
 * the register, the money raised against it, the land those records describe,
 * and the portal's own administration.
 *
 * A flat list of ten was past scannable — «القطاعات» and «الموظفون» read as
 * equally likely neighbours of «المواطنون» when they belong to different jobs
 * entirely.
 *
 * Money used to sit inside «السجل», on the reasoning that a fee is issued
 * against the register rather than configured apart from it. That reasoning is
 * still true and it stopped being the useful cut: «السجل» had grown to eight of
 * the fifteen rows, which is the flat list again wearing a heading. «المالية»
 * is also a job rather than a subject — the COLLECTOR and the ACCOUNTANT work
 * there and almost nowhere else, and giving them one heading to fold to is
 * worth more than keeping the fee beside the citizen it is owed by.
 *
 * `defaultPathFor` reads this order, so the landing pair stays first and
 * keeps `/dashboard` ahead of `/inspector/profile`: every role's
 * first visible row is the same one it was before the split.
 */
export const NAV_GROUPS: NavGroup[] = [
  /*
    Where each role lands, and nothing else.

    These two answer the same question for different people — «what is mine to
    look at» — and neither is a section of the register. The dashboard is the
    municipality's figures for whoever answers for them; «أرباحي» is one
    inspector's own work. They are disjoint in practice, so most roles see a
    single row here.
  */
  {
    items: [
      /*
        Oversight only.

        The whole municipality's figures on one screen — arrears, collection
        rates, household distributions — is a管理 view, not a working one, so
        it is held to the roles that answer for those numbers rather than the
        ones that generate them. `FIELD_INSPECTOR` used to be on this list and
        is not any more: an inspector's own screen is «أرباحي والمسح الميداني»
        below, which reports their work without exposing everybody else's.

        `DashboardController.counters` and `.analytics` were narrowed to match.
        The `map*` endpoints on that same controller keep their wider lists —
        they serve «الخريطة», which is a working screen.
      */
      {
        path: '/dashboard',
        label: 'لوحة التحكم',
        labelEn: 'Dashboard',
        icon: LayoutDashboard,
        roles: ['SUPER_ADMIN', 'AUDITOR'],
        keywords: ['مؤشرات', 'تحليلات', 'إحصاءات', 'dashboard', 'analytics'],
      },
      // Self-service: `StaffController.getMyProfile` answers for whoever is
      // asking, so every role has a page here and none of them can see another
      // person's.
      {
        path: '/inspector/profile',
        label: 'أرباحي والمسح الميداني',
        labelEn: 'Inspector Earnings',
        icon: BadgeDollarSign,
        roles: EVERY_STAFF_ROLE,
        keywords: ['أرباح', 'عمولة', 'مفتش', 'مسح', 'عقارات', 'inspector', 'earnings'],
      },
    ],
  },
  {
    label: 'السجل',
    labelEn: 'Registry',
    items: [
      // The register itself — one row per person. Readable by every role;
      // writing is narrower, which is «تسجيل مواطن جديد» below.
      {
        path: '/citizens',
        label: 'المواطنون',
        labelEn: 'Citizens',
        icon: Users,
        roles: EVERY_STAFF_ROLE,
        keywords: ['سجل', 'مواطن', 'عقار', 'استيراد', 'citizens', 'registry'],
      },
      /*
        The counter's most-used action, promoted to a row of its own.

        It was reachable only as a button on «المواطنون», which put the one
        thing a clerk does forty times a day two screens from where they land
        and made it invisible to the command palette. A distinct row also gives
        the draft-restore notice somewhere to live: leaving this page no longer
        discards what has been typed (see `citizen-draft.ts`), and that promise
        only makes sense if there is a page to come back *to*.

        Narrower than «المواطنون» deliberately — these are the roles
        `CitizenEditor` admits and `CitizenController.create` accepts. An
        `AUDITOR` reads the register and does not add to it, so offering them
        the form would be offering a save the server refuses.
      */
      {
        path: '/citizens/new',
        label: 'تسجيل مواطن جديد',
        labelEn: 'Register Citizen',
        icon: UserPlus,
        roles: ['SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER'],
        keywords: ['تسجيل', 'مواطن', 'جديد', 'إضافة', 'أسرة', 'نموذج', 'register', 'new', 'add'],
      },
      /*
        Owner claims waiting to be recognised as one of the register's own
        citizens.

        Beside «المواطنون» rather than under the census, because what it
        resolves is an *identity* — is the person this tenant named the same
        person as this record — and the census tables are downstream of the
        answer rather than the subject of it.

        Every staff role, matching «المواطنون» directly above: the queue is a
        view of the register and reading it discloses nothing the registry does
        not. Acting on a row is narrower and enforced by the server — AUDITOR,
        COLLECTOR and ACCOUNTANT see the work and do not answer it.
      */
      {
        path: '/citizens/landlord-links',
        label: 'روابط المالكين',
        labelEn: 'Owner Links',
        icon: Link2,
        roles: EVERY_STAFF_ROLE,
        keywords: [
          'مالك',
          'مستأجر',
          'ربط',
          'هاتف',
          'إيجار',
          'landlord',
          'owner',
          'link',
          'tenant',
        ],
      },
      /*
        The second pair of eyes on what the field filed.

        Beside the register rather than under «النظام»: what it reviews is the
        records themselves, and the person doing it moves between this screen
        and «المواطنون» all day. Held to the roles `QualityController` lets
        decide — an officer's own returned records and re-checks are on their
        own «أرباحي والمسح الميداني» instead, so nobody is offered a screen
        that would only tell them their work is being watched.
      */
      {
        path: '/quality',
        label: 'مراجعة الجودة',
        labelEn: 'Quality Review',
        icon: ClipboardCheck,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'ADMINISTRATIVE_OFFICER'],
        keywords: [
          'مراجعة',
          'جودة',
          'تكرار',
          'تدقيق',
          'اعتماد',
          'إعادة',
          'تحقق ميداني',
          'quality',
          'review',
          'duplicates',
        ],
      },
      // A visit that didn't produce a citizen — nobody home, gate locked —
      // sits next to the registry it feeds rather than under land/map, since
      // what it records is "who to go back to", not a parcel's own facts.
      {
        path: '/cases',
        label: 'الحالات',
        labelEn: 'Cases',
        icon: ClipboardList,
        roles: EVERY_STAFF_ROLE,
        keywords: ['زيارة', 'لا أحد في المنزل', 'متابعة', 'cases', 'follow-up', 'visit'],
      },
    ],
  },
  {
    label: 'المالية',
    labelEn: 'Finance',
    items: [
      /*
        Beside the registry rather than under settings: a fee is issued
        against the citizens in it, not configured in isolation.

        `FIELD_INSPECTOR` is absent, and that is not a new restriction — it is
        the one `FeesController` has always enforced on `notices`, `summary`,
        `titles` and `payments`. The row simply stopped claiming otherwise.
      */
      {
        path: '/fees',
        label: 'الرسوم والمدفوعات',
        labelEn: 'Fees & Billing',
        icon: Receipt,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER'],
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
      // Between the map and the sectors on purpose: the census is what the map
      // draws pins from and what a sector is ultimately a count of. Open to
      // every staff role that may open the map — a collector needs a building's
      // code to find a door as much as an inspector needs it to survey one.
      {
        path: '/buildings',
        label: 'سجل المباني',
        labelEn: 'Building Census',
        icon: Building2,
        roles: [
          'SUPER_ADMIN',
          'AUDITOR',
          'FIELD_INSPECTOR',
          'COLLECTOR',
          'ACCOUNTANT',
          'ADMINISTRATIVE_OFFICER',
        ],
        keywords: ['مبنى', 'مباني', 'وحدات', 'شقق', 'مسح', 'ضرر', 'إحصاء', 'buildings', 'units', 'census', 'damage'],
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
        // The two roles `AuditController` serves — the auditor is who the log is for.
        roles: ['SUPER_ADMIN', 'AUDITOR'],
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
      // Everyone has a password to change and a second factor to enrol, and it
      // is their own — there is no role for which this is someone else's data.
      {
        path: '/account',
        label: 'أمان الحساب',
        labelEn: 'Account Security',
        icon: KeyRound,
        roles: EVERY_STAFF_ROLE,
        keywords: ['كلمة المرور', 'أمان', 'حسابي', 'مصادقة', '2fa', 'password', 'security', 'account'],
      },
    ],
  },
];

/**
 * The groups this role may see, with empty groups dropped entirely.
 *
 * A role of `undefined` — a session still loading, or one whose claim carries
 * no role — now sees **nothing**, where it previously saw every unguarded row.
 * That inversion is the point of making `roles` required: the sidebar renders
 * before the session is read, and "we do not know who this is yet" must not be
 * the state in which the most permissive answer is given.
 */
export function visibleGroups(role: string | undefined): NavGroup[] {
  if (!role) return [];
  return NAV_GROUPS
    .filter((group) => !group.roles || group.roles.includes(role))
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.roles.includes(role)),
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
  // '' for the unlabelled landing group. Callers render a heading only when
  // there is one, so this never reaches the screen.
  return (locale === 'en' && group.labelEn ? group.labelEn : group.label) ?? '';
}
