import {
  ArrowLeftRight,
  BadgeDollarSign,
  BanknoteArrowDown,
  BanknoteArrowUp,
  Building2,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  DoorClosed,
  FileQuestion,
  FileWarning,
  HandCoins,
  KeyRound,
  LandPlot,
  Landmark,
  LayoutDashboard,
  Layers,
  Link2,
  Map as MapIcon,
  ReceiptText,
  ScanSearch,
  Settings,
  ShieldCheck,
  ShieldQuestion,
  UserPlus,
  UserRoundCheck,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  AUDIT_READ_ROLES,
  DASHBOARD_READ_ROLES,
  EVERY_STAFF_ROLE,
  FEE_READ_ROLES,
  MAP_READ_ROLES,
  PAYMENT_REVIEW_READ_ROLES,
  TREASURY_READ_ROLES,
  WORKING_STAFF_ROLES,
} from '@mechanization/shared-schemas';
import { QUALITY_REVIEWER_ROLES, WORKLIST_ROLES } from '@/lib/staff-roles';

/*
 * Every row's roles come from the shared role sets the API's `@Roles` are
 * built from (`@mechanization/shared-schemas`, `role-sets.ts`), so a row and
 * the route it opens change together.
 *
 * `EVERY_STAFF_ROLE` — every staff role there is, spelled out rather than left
 * implicit.
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
 * An unlabelled landing group, then seven groups — one per job, in the order a
 * municipality's day runs: the people in the register, the buildings and the
 * land they live on, the visits still owed in the field, the fees raised and
 * collected, the treasury's books, the checking of all of it, and the portal's
 * own administration.
 *
 * ## How it is cut (reorganised 2026-10-09)
 *
 * By the job, not by the screen. A group is what one kind of person works in,
 * so each of them can fold the rest away (the sidebar remembers folds by
 * group label):
 *
 *  - «المواطنون» — the register of people and the queues that feed it: a
 *    record saved with gaps, an owner a tenant named who is not yet linked.
 *    Those queues keep filling after the survey (ending an ownership sends its
 *    tenants back to «روابط المالكين»), so they sit beside the register they
 *    drain into rather than in a group of their own.
 *  - «المباني والأرض» — the census and the map drawn from it, with the sectors.
 *  - «العمل الميداني» — the visits still owed: units nobody has surveyed,
 *    doors that were shut, flats waiting for the visit after repair. These
 *    drain toward zero once the survey is done, which is why they are a group
 *    of their own: a clerk past the survey folds it away instead of scrolling
 *    past three quiet queues.
 *  - «الرسوم والجباية» and «الخزينة» — money, as two jobs. Billing citizens
 *    is the collector's and the counter's; the treasury's books are the
 *    accountant's. One «المالية» of seven rows was the flat list again, and a
 *    collector saw a heading of which he could open three rows.
 *
 * No group holds more than five rows: past that a heading stops helping the
 * eye find a row. Each row has an icon of its own, so a folded rail still tells
 * its rows apart.
 *
 * `defaultPathFor` reads this order, so the landing group stays first and
 * unchanged — `/dashboard` ahead of `/inspector/profile` ahead of `/my-round`
 * — and every role lands where it landed before.
 */
export const NAV_GROUPS: NavGroup[] = [
  /*
    Where each role lands, and nothing else.

    These answer the same question for different people — «what is mine to
    look at» — and none is a section of the register. The dashboard is the
    municipality's figures for whoever answers for them; «أرباحي» is one
    inspector's own work; «جولتي» is the cash in one collector's pocket.
  */
  {
    items: [
      /*
        Oversight only.

        The whole municipality's figures on one screen — arrears, collection
        rates, household distributions — is an oversight view, not a working
        one, so it is held to the roles that answer for those numbers rather
        than the ones that generate them. `FIELD_INSPECTOR` used to be on this
        list and is not any more: an inspector's own screen is «أرباحي والمسح
        الميداني» below, which reports their work without exposing everybody
        else's.

        `DashboardController.counters` and `.analytics` were narrowed to match.
        The `map*` endpoints on that same controller keep their wider lists —
        they serve «الخريطة», which is a working screen.
      */
      {
        path: '/dashboard',
        label: 'لوحة التحكم',
        labelEn: 'Dashboard',
        icon: LayoutDashboard,
        roles: DASHBOARD_READ_ROLES,
        keywords: ['مؤشرات', 'تحليلات', 'إحصاءات', 'dashboard', 'analytics'],
      },
      // Self-service: `StaffController.getMyProfile` answers for whoever is
      // asking, so every role has a page here and none of them can see another
      // person's. Every role but «مشاهد فقط», who surveys nothing and earns
      // nothing — and whom that route does not admit.
      {
        path: '/inspector/profile',
        label: 'أرباح المسح الميداني',
        labelEn: 'My earnings & survey',
        icon: BadgeDollarSign,
        roles: WORKING_STAFF_ROLES,
        keywords: ['أرباح', 'عمولة', 'مفتش', 'مسح', 'عقارات', 'inspector', 'earnings'],
      },
      /*
        Self-service too, and for the same reason: `transfers.myRound` answers
        for whoever is asking and there is no id in the path to point elsewhere.
        A man carrying the municipality's cash is owed the answer to «كم
        بجيبتي؟» without being given sight of the books — which is why this is
        the one treasury screen outside `TREASURY_READ_ROLES`.

        `WORKING_STAFF_ROLES` rather than `COLLECTOR`, because nothing
        restricts who may be named on a payment: in practice it is the field
        inspectors who carry the cash. Staff holding no custody get an empty
        round, which is the honest answer to the question rather than a locked
        door.
      */
      {
        path: '/my-round',
        label: 'جولتي',
        labelEn: 'My round',
        icon: Wallet,
        roles: WORKING_STAFF_ROLES,
        keywords: ['جولة', 'عهدة', 'جابي', 'تحصيل', 'نقدي', 'round', 'custody', 'collector'],
      },
    ],
  },
  {
    label: 'المواطنون',
    labelEn: 'Citizens',
    items: [
      /*
        The register itself — one row per person. Readable by every role;
        writing is narrower, which is «تسجيل مواطن جديد» below. Named «سجل
        المواطنين» now that the group carries «المواطنون», and to sit beside
        «سجل المباني» as the other register.
      */
      {
        path: '/citizens',
        label: 'سجل المواطنين',
        labelEn: 'Citizen register',
        icon: Users,
        roles: EVERY_STAFF_ROLE,
        keywords: ['سجل', 'مواطن', 'مواطنون', 'عقار', 'استيراد', 'citizens', 'registry'],
      },
      /*
        The counter's most-used action, promoted to a row of its own.

        It was reachable only as a button on the register, which put the one
        thing a clerk does forty times a day two screens from where they land
        and made it invisible to the command palette. A distinct row also gives
        the draft-restore notice somewhere to live: leaving this page no longer
        discards what has been typed (see `citizen-draft.ts`), and that promise
        only makes sense if there is a page to come back *to*.

        Narrower than the register deliberately — these are the roles
        `CitizenEditor` admits and `CitizenController.create` accepts. An
        `AUDITOR` reads the register and does not add to it, so offering them
        the form would be offering a save the server refuses.
      */
      {
        path: '/citizens/new',
        label: 'تسجيل مواطن جديد',
        labelEn: 'Register a citizen',
        icon: UserPlus,
        roles: ['SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER'],
        keywords: ['تسجيل', 'مواطن', 'جديد', 'إضافة', 'أسرة', 'نموذج', 'register', 'new', 'add'],
      },
      /*
        The register narrowed to records saved with fields still to confirm —
        the same page as the register at an address of its own, so every role
        that reads the register reads this slice of it.
      */
      {
        path: '/citizens/review',
        label: 'يتطلب مراجعة',
        labelEn: 'Requires review',
        icon: FileQuestion,
        roles: EVERY_STAFF_ROLE,
        keywords: ['مراجعة', 'ناقص', 'استكمال', 'حقول', 'غير مؤكد', 'review', 'incomplete', 'missing'],
      },
      /*
        Owner claims waiting to be recognised as one of the register's own
        citizens: what it resolves is an *identity* — is the person this
        tenant named the same person as this record.

        Every staff role, matching the register: the queue is a view of it and
        reading it discloses nothing the registry does not. Acting on a row is
        narrower and enforced by the server — AUDITOR, COLLECTOR and ACCOUNTANT
        see the work and do not answer it.
      */
      {
        path: '/citizens/landlord-links',
        label: 'روابط المالكين',
        labelEn: 'Owner links',
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
    ],
  },
  {
    label: 'المباني والأرض',
    labelEn: 'Buildings & land',
    items: [
      /*
        The census first: it is the register of structures, as the group above
        leads with the register of people, and it is what the map draws its
        pins from and what a sector is ultimately a count of. Open to every
        staff role — a collector needs a building's code to find a door as much
        as an inspector needs it to survey one.
      */
      {
        path: '/buildings',
        label: 'سجل المباني',
        labelEn: 'Building census',
        icon: Building2,
        roles: EVERY_STAFF_ROLE,
        keywords: ['مبنى', 'مباني', 'وحدات', 'شقق', 'مسح', 'ضرر', 'إحصاء', 'buildings', 'units', 'census', 'damage'],
      },
      {
        path: '/map',
        label: 'الخريطة',
        labelEn: 'Cadastral map',
        icon: MapIcon,
        roles: MAP_READ_ROLES,
        keywords: ['عقارات', 'مواقع', 'مسح', 'map', 'cadastre'],
      },
      {
        path: '/zones',
        label: 'القطاعات',
        labelEn: 'Zones',
        icon: Layers,
        roles: EVERY_STAFF_ROLE,
        keywords: ['قطاع', 'منطقة', 'حدود', 'zones', 'districts'],
      },
    ],
  },
  /*
    «العمل الميداني» — the visits still owed: each row is a list of doors to go
    back to. They drain toward zero once the survey is done, so a clerk or an
    accountant past it folds this group away (the sidebar remembers it).
    Folded, not removed: a locked gate still opens a case after the survey,
    and a damage reading still sends a flat to re-inspection.
  */
  {
    label: 'العمل الميداني',
    labelEn: 'Field work',
    items: [
      /*
        Units nobody has surveyed or registered anyone in yet — each officer's
        own (the buildings they added), everyone's for the admins. The roles
        that put work on the census, plus the ones that see everyone's
        (`CENSUS_WORKLIST_ROLES`); an accountant's list would always be empty.
      */
      {
        path: '/buildings/unsurveyed',
        label: 'وحدات غير ممسوحة',
        labelEn: 'Unsurveyed units',
        icon: ScanSearch,
        roles: WORKLIST_ROLES,
        keywords: ['مسح', 'غير ممسوحة', 'وحدة', 'زيارة', 'ميداني', 'unsurveyed', 'survey', 'unit'],
      },
      // A visit that didn't produce a citizen — nobody home, gate locked: what
      // it records is "who to go back to", not a parcel's own facts.
      {
        path: '/cases',
        label: 'الحالات',
        labelEn: 'Cases',
        icon: DoorClosed,
        roles: EVERY_STAFF_ROLE,
        keywords: ['زيارة', 'لا أحد في المنزل', 'متابعة', 'cases', 'follow-up', 'visit'],
      },
      /*
        Flats and structures read «غير صالحة للسكن», waiting for the visit after
        repair that releases their fee hold — each officer's own readings,
        everyone's for the admins.
      */
      {
        path: '/buildings/reinspections',
        label: 'بانتظار إعادة الكشف',
        labelEn: 'Awaiting re-inspection',
        icon: CalendarClock,
        roles: WORKLIST_ROLES,
        keywords: ['إعادة الكشف', 'غير صالحة للسكن', 'ترميم', 'ضرر', 'reinspection', 'uninhabitable', 'repair'],
      },
    ],
  },
  /*
    «الرسوم والجباية» — what citizens are billed and what they have paid: the
    collector's and the counter's job. Next to the field work above it and
    ahead of the treasury below, because a fee is owed by a citizen and only
    becomes the treasury's money once it is paid.
  */
  {
    label: 'الرسوم والجباية',
    labelEn: 'Fees & collection',
    items: [
      /*
        `FIELD_INSPECTOR` is absent, and that is not a new restriction — it is
        the one `FeesController` has always enforced on `notices`, `summary`,
        `titles` and `payments`. The row simply stopped claiming otherwise.
      */
      {
        path: '/fees',
        label: 'الرسوم والمدفوعات',
        labelEn: 'Fees & billing',
        icon: ReceiptText,
        roles: FEE_READ_ROLES,
        keywords: ['رسم', 'مطالبة', 'فاتورة', 'دفع', 'fees', 'billing'],
      },
      // Read-only: the ledger above answers "who owes what", this answers
      // "what has been paid". An auditor lives here.
      {
        path: '/payments',
        label: 'سجل العمليات',
        labelEn: 'Payment operations',
        icon: ArrowLeftRight,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'VIEWER'],
        keywords: ['قبض', 'إيصال', 'محصّل', 'نقد', 'payments', 'transactions'],
      },
      /*
        Open bills a correction to the register affected — the accountant's
        worklist, since a correction never changes a bill by itself. The
        auditor reads it; the collector and the office do not decide on bills.
      */
      {
        path: '/fees/corrections',
        label: 'فواتير تأثّرت بتصحيحات',
        labelEn: 'Bills affected by corrections',
        icon: FileWarning,
        roles: PAYMENT_REVIEW_READ_ROLES,
        keywords: ['تصحيح', 'فاتورة', 'فرق', 'مراجعة', 'corrections', 'bills', 'difference'],
      },
      /*
        «المستحق على عقار» — the question asked before a براءة ذمّة: what is
        still owed on a parcel, whoever's file it is on. Read-only, so every
        role that reads the ledger may ask it. `LandPlot`, not `Landmark`:
        that one is the treasury's «الأرصدة», and no two rows share an icon.
      */
      {
        path: '/fees/parcel',
        label: 'المستحق على عقار',
        labelEn: 'Owed on a parcel',
        icon: LandPlot,
        roles: FEE_READ_ROLES,
        keywords: ['براءة ذمة', 'براءة ذمّة', 'رقم العقار', 'مستحق', 'دين', 'clearance', 'parcel', 'owed'],
      },
    ],
  },
  /*
    «الخزينة» — the municipality's books: where its money is, what reached it
    and what left it. The accountant's job, on `TREASURY_READ_ROLES` throughout.
    No row, no guard: `canAccessPath` opens a path nobody listed to every role,
    which is why each treasury page has a row here.
  */
  {
    label: 'الخزينة',
    labelEn: 'Treasury',
    items: [
      /*
        The wallets and their balances. «الأرصدة» rather than «الخزينة» now that
        the group carries that name. Activating the treasury is narrower still
        (the manager) and is gated on the page itself.
      */
      {
        path: '/finance',
        label: 'الأرصدة',
        labelEn: 'Balances',
        icon: Landmark,
        roles: TREASURY_READ_ROLES,
        keywords: ['خزينة', 'صندوق', 'رصيد', 'أرصدة', 'حساب', 'نقد', 'treasury', 'safe', 'balance', 'cash'],
      },
      /*
        What each collector still carries, and the handover into the safe.
        Reading is `TREASURY_READ_ROLES`, the list `TransfersController` puts on
        `GET /treasury/transfers/custody`; receiving is `TREASURY_WORK_ROLES`
        and is gated on the page. The longest match wins (`activeNavItem`), so
        a collector's own page, `/finance/collectors/:id`, lights this row up.
      */
      {
        path: '/finance/collectors',
        label: 'الجباة والتحصيل',
        labelEn: 'Collectors & handover',
        icon: HandCoins,
        roles: TREASURY_READ_ROLES,
        keywords: ['جباة', 'جابي', 'عهدة', 'تحصيل', 'تسليم', 'استلام', 'collectors', 'custody', 'handover'],
      },
      /*
        Money in that no citizen's bill brought: the Independent Municipal
        Fund, permits, rent, grants, fines. Before النفقات, so the group reads
        money in, then money out — and their icons say it: a note going up,
        a note going down. Recording and cancelling are narrower and are gated
        on the pages and by `IncomeController`.
      */
      {
        path: '/finance/income',
        label: 'الإيرادات',
        labelEn: 'Income',
        icon: BanknoteArrowUp,
        roles: TREASURY_READ_ROLES,
        keywords: ['إيرادات', 'إيراد', 'قبض', 'سند قبض', 'صندوق بلدي', 'رخص', 'هبات', 'غرامات', 'income', 'revenue', 'receipt'],
      },
      /*
        Its own row, not a child of /finance: it is where an accountant spends
        the day, and `activeNavItem` matches the longest path, so this lights up
        instead of the balances when the register is open. Recording and
        cancelling are narrower and are gated on the page and by
        `ExpensesController`.
      */
      {
        path: '/finance/expenses',
        label: 'النفقات',
        labelEn: 'Expenses',
        icon: BanknoteArrowDown,
        roles: TREASURY_READ_ROLES,
        keywords: ['نفقات', 'صرف', 'مصاريف', 'سند صرف', 'فاتورة', 'expense', 'spending', 'voucher', 'payout'],
      },
    ],
  },
  /*
    Checking the work, as its own section.

    «مراجعة الجودة» was one row opening one page of four tabs, and a tab is not
    addressable: it cannot be linked from a notification, cannot be opened in a
    second window beside the register, and hides three of the four screens from
    the command palette. Four rows, four pages. «سجل النشاطات» belongs here for
    the same reason: an auditor reading who changed what is doing this job, not
    configuring the municipality, and «النظام» is left as what it says —
    settings and accounts.

    Every quality row is held to the roles `QualityController` enforces with
    `QUALITY_REVIEWER_ROLES`. An officer's own returned records and the re-checks they
    may do are on «أرباحي والمسح الميداني» instead, so nobody is offered a
    screen that would only tell them their work is being watched.
  */
  {
    label: 'المراجعة والتدقيق',
    labelEn: 'Review & audit',
    items: [
      {
        path: '/quality/reviews',
        label: 'السجلات',
        labelEn: 'Records to review',
        icon: ClipboardCheck,
        roles: QUALITY_REVIEWER_ROLES,
        keywords: ['مراجعة', 'اعتماد', 'إعادة', 'جودة', 'review', 'approve', 'return'],
      },
      {
        path: '/quality/findings',
        label: 'ملاحظات الجودة',
        labelEn: 'Quality findings',
        icon: ShieldQuestion,
        roles: QUALITY_REVIEWER_ROLES,
        keywords: ['تكرار', 'جودة', 'تناقض', 'ملاحظات', 'findings', 'duplicates', 'quality'],
      },
      {
        path: '/quality/checks',
        label: 'التحقق الميداني',
        labelEn: 'Field re-checks',
        icon: ClipboardList,
        roles: QUALITY_REVIEWER_ROLES,
        keywords: ['تحقق', 'عيّنة', 'ميداني', 'check', 'sample', 'field'],
      },
      {
        path: '/quality/officers',
        label: 'الجودة حسب الموظف',
        labelEn: 'Quality by officer',
        icon: UserRoundCheck,
        roles: QUALITY_REVIEWER_ROLES,
        keywords: ['موظف', 'أداء', 'جودة', 'officer', 'performance', 'quality'],
      },
      {
        path: '/audit',
        label: 'سجل النشاطات',
        labelEn: 'Audit log',
        icon: ShieldCheck,
        // The two roles `AuditController` serves — the auditor is who the log is for.
        roles: AUDIT_READ_ROLES,
        keywords: ['تدقيق', 'تاريخ', 'تغييرات', 'audit', 'logs'],
      },
    ],
  },
  {
    label: 'النظام',
    labelEn: 'System',
    items: [
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
        labelEn: 'Staff management',
        icon: UsersRound,
        roles: ['SUPER_ADMIN'],
        keywords: ['موظف', 'صلاحيات', 'حساب', 'staff', 'users'],
      },
      // Everyone has a password to change and a second factor to enrol, and it
      // is their own — there is no role for which this is someone else's data.
      {
        path: '/account',
        label: 'أمان الحساب',
        labelEn: 'Account security',
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
