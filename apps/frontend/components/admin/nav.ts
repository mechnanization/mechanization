import {
  ArrowDownUp,
  ArrowLeftRight,
  ArrowRightLeft,
  BadgeDollarSign,
  Building2,
  CalendarCheck,
  ClipboardCheck,
  DoorClosed,
  FileCheck,
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
  Megaphone,
  Newspaper,
  ReceiptText,
  ScanSearch,
  ScrollText,
  Settings,
  ShieldCheck,
  Tags,
  UserPlus,
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
  NEWS_EDITOR_ROLES,
  PAYMENT_REVIEW_READ_ROLES,
  REQUEST_READ_ROLES,
  TREASURY_READ_ROLES,
  TREASURY_WORK_ROLES,
  WORKING_STAFF_ROLES,
} from '@mechanization/shared-schemas';
import { CITIZEN_RECORD_EDIT_ROLES, QUALITY_REVIEWER_ROLES, WORKLIST_ROLES } from '@/lib/staff-roles';
import ar from '../../messages/ar.json';
import en from '../../messages/en.json';

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

/** The names a row can have: `messages.nav.items`, in both languages (`messages-parity.test.ts`). */
export type NavKey = keyof typeof ar.nav.items;
/** The headings a group can have: `messages.nav.groups`. */
export type NavGroupKey = keyof typeof ar.nav.groups;

export interface NavItem {
  /** Appended to the tenant's admin base path. */
  path: string;
  /**
   * What it is called, as a key into `messages.nav.items` (NAV-10): the sidebar,
   * the header's crumb and the command palette read it through `localizedLabel`,
   * and the page's own title reads the same message, so the wording is changed
   * in one place and the row and its page cannot drift apart.
   */
  key: NavKey;
  icon: LucideIcon;
  /**
   * Who may see this row. Required — see `EVERY_STAFF_ROLE` for why a row that
   * is open to everybody says so rather than leaving it off.
   */
  roles: readonly string[];
  /** Extra words the command palette matches on, beyond the label. */
  keywords?: string[];
  /**
   * Older addresses this row still owns: pages under them are guarded by this
   * row's roles and light it up, as if they sat under `path`. For a section
   * whose documents kept their addresses when its register moved — the printed
   * vouchers under `/finance/income` and `/finance/expenses` belong to
   * «الحركات المالية» (`/finance/transactions`). Never listed in the sidebar.
   */
  also?: readonly string[];
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
   *
   * Omitted for one more group (NAV-05, decided 2026-11-25): «الأخبار», a group
   * of one row that is its own name. A heading over it would say «الأخبار»
   * twice. It is drawn as its row between two rules, and cannot be folded:
   * there is nothing in it to hide but the row.
   */
  /** A key into `messages.nav.groups`; the heading. Omitted where there is no heading, as above. */
  key?: NavGroupKey;
  /** Omitted = the group itself gates nothing; its rows still do. */
  roles?: readonly string[];
  items: NavItem[];
}

/**
 * An unlabelled landing group, then eight groups — one per job, in the order a
 * municipality's day runs: the people in the register, the buildings and the
 * land they live on, the visits still owed in the field, the fees raised and
 * collected, the treasury's books, the checking of all of it, the News kept on
 * Day3ati, and the portal's own administration.
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
 *    and the collectors' rounds, down to the handover, are the collection
 *    side; the treasury's books are the accountant's. One «المالية» of seven
 *    rows was the flat list again, and a collector saw a heading of which he
 *    could open three rows.
 *
 * No group holds more than five rows: past that a heading stops helping the
 * eye find a row. Each row has an icon of its own, so a folded rail still tells
 * its rows apart.
 *
 * `defaultPathFor` reads this order, so the landing group stays first and
 * unchanged — `/dashboard` ahead of `/inspector/profile` ahead of `/my-round`
 * — and every role lands where it landed before.
 *
 * ## The approved map (NAV-01, decided 2026-11-25; docs/open-decisions.md §25)
 *
 * The rows below are 26, the approved map: NAV-02, NAV-05, NAV-06 and NAV-07
 * (their pages are in `OFF_SIDEBAR_PAGES`, after this list), NAV-03, NAV-04,
 * NAV-11 and PAGE-01 have all moved (2026-11-25). The map:
 *
 *  - (landing): لوحة التحكم · أرباح المسح الميداني · جولتي — unchanged.
 *  - «المواطنون»: سجل المواطنين · ملفات ناقصة · روابط المالكين · طلبات المعاملات.
 *    «تسجيل مواطن جديد» leaves (NAV-02: the citizens page's header, the
 *    unsurveyed worklist and the palette open it; `/citizens/new` first turns
 *    away roles outside `CITIZEN_RECORD_EDIT_ROLES` itself). «يتطلب مراجعة» is
 *    renamed «ملفات ناقصة» / "Incomplete files" (NAV-11).
 *  - «المباني والأرض»: سجل المباني · الخريطة · القطاعات — unchanged.
 *  - «العمل الميداني»: قوائم العمل الميداني (tabs: غير ممسوحة / بانتظار إعادة
 *    الكشف, NAV-04) · الحالات. The merged row keeps both old paths in `also`.
 *  - «الرسوم والجباية»: الرسوم والمدفوعات · سجل العمليات · المستحق على عقار ·
 *    الجباة والتحصيل. «فواتير تأثّرت بتصحيحات» leaves (NAV-07: the fees page's
 *    header opens it; the page first gates its own reading to
 *    `PAYMENT_REVIEW_READ_ROLES`). «المستحق على عقار» keeps its row (NAV-08).
 *    «سجل العمليات» stays its own row (PAGE-05, decided 2026-11-24).
 *  - «الخزينة»: unchanged (5).
 *  - «المراجعة والتدقيق»: الجودة (tabs: اعتماد السجلات / الملاحظات / التحقق
 *    الميداني / حسب الموظف, NAV-03; `also` holds the four old paths) · سجل
 *    النشاطات. «السجلات» becomes the tab «اعتماد السجلات» / "Record approval" (NAV-11).
 *  - «الأخبار»: one row, «الأخبار», shown under its own name with no group
 *    heading above it (the owner's words: "in the side bar as its name");
 *    categories and publishers open from the articles page's header (NAV-05,
 *    done 2026-11-25): `NavGroup.label` is documented for two unlabelled groups
 *    now, and `lib/nav.test.ts` pins the landing group unlabelled and first and
 *    this one as the only other.
 *  - «النظام»: إعدادات البلدية · الموظفون. «أمان الحساب» is in the user menu
 *    only (NAV-06); settings loses its «المستخدمون» tab, which repeats `/staff` (PAGE-01).
 *
 * 26 rows. Every removal keeps its page reachable: a path with no row opens to
 * every role (`canAccessPath`), so a page that must not, gates itself first.
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
        key: 'dashboard',
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
        key: 'earnings',
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
        key: 'myRound',
        icon: Wallet,
        roles: WORKING_STAFF_ROLES,
        keywords: ['جولة', 'عهدة', 'جابي', 'تحصيل', 'نقدي', 'round', 'custody', 'collector'],
      },
    ],
  },
  {
    key: 'citizens',
    items: [
      /*
        The register itself — one row per person. Readable by every role;
        writing is narrower, which is «تسجيل مواطن جديد» below. Named «سجل
        المواطنين» now that the group carries «المواطنون», and to sit beside
        «سجل المباني» as the other register.
      */
      {
        path: '/citizens',
        key: 'citizens',
        icon: Users,
        roles: EVERY_STAFF_ROLE,
        keywords: ['سجل', 'مواطن', 'مواطنون', 'عقار', 'استيراد', 'citizens', 'registry'],
      },
      /*
        The register narrowed to records saved with fields still to confirm —
        the same page as the register at an address of its own, so every role
        that reads the register reads this slice of it.
      */
      {
        path: '/citizens/review',
        // «ملفات ناقصة», not «يتطلب مراجعة» (NAV-11): the other queue, «اعتماد السجلات» in «الجودة», is the one that reviews.
        key: 'incompleteFiles',
        icon: FileQuestion,
        roles: EVERY_STAFF_ROLE,
        keywords: ['ناقص', 'ناقصة', 'استكمال', 'حقول', 'غير مؤكد', 'مراجعة', 'يتطلب مراجعة', 'review', 'incomplete', 'missing'],
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
        key: 'ownerLinks',
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
        «طلبات المعاملات» — what citizens ask the municipality for (a براءة ذمة,
        a إفادة سكن…), filed online or at the counter, with the paper printed
        and handed over here (docs/municipal-requests-plan.md). The readers of
        `REQUEST_READ_ROLES`, as `CitizenRequestsController`: not «مشاهد فقط»,
        because the papers on a request are identity copies. Filing at the
        counter, approving and handing over are narrower and gated on the pages.
      */
      {
        path: '/requests',
        key: 'requests',
        icon: FileCheck,
        roles: REQUEST_READ_ROLES,
        keywords: ['طلب', 'معاملة', 'إفادة', 'براءة ذمة', 'إفادة سكن', 'شغور', 'requests', 'certificate', 'clearance'],
      },
    ],
  },
  {
    key: 'buildings',
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
        key: 'buildings',
        icon: Building2,
        roles: EVERY_STAFF_ROLE,
        keywords: ['مبنى', 'مباني', 'وحدات', 'شقق', 'مسح', 'ضرر', 'إحصاء', 'buildings', 'units', 'census', 'damage'],
      },
      {
        path: '/map',
        key: 'map',
        icon: MapIcon,
        roles: MAP_READ_ROLES,
        keywords: ['عقارات', 'مواقع', 'مسح', 'map', 'cadastre'],
      },
      {
        path: '/zones',
        key: 'zones',
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
    key: 'fieldWork',
    items: [
      /*
        The two lists of doors to go back to, as the tabs of one page (NAV-04,
        2026-11-25): units nobody has surveyed or registered anyone in yet, and
        the flats and structures read «غير صالحة للسكن» that wait for the visit
        after repair, which releases their fee hold. Each officer's own (the
        buildings they added, the readings they recorded), everyone's for the
        admins. The roles that put work on the census, plus the ones that see
        everyone's (`CENSUS_WORKLIST_ROLES`); an accountant's list would always
        be empty. The old addresses forward to a tab and stay the row's own.
      */
      {
        path: '/buildings/worklists',
        key: 'fieldWorklists',
        icon: ScanSearch,
        also: ['/buildings/unsurveyed', '/buildings/reinspections'],
        roles: WORKLIST_ROLES,
        keywords: [
          'مسح',
          'غير ممسوحة',
          'وحدة',
          'زيارة',
          'ميداني',
          'إعادة الكشف',
          'غير صالحة للسكن',
          'ترميم',
          'ضرر',
          'unsurveyed',
          'survey',
          'unit',
          'reinspection',
          'uninhabitable',
          'repair',
        ],
      },
      // A visit that didn't produce a citizen — nobody home, gate locked: what
      // it records is "who to go back to", not a parcel's own facts.
      {
        path: '/cases',
        key: 'cases',
        icon: DoorClosed,
        roles: EVERY_STAFF_ROLE,
        keywords: ['زيارة', 'لا أحد في المنزل', 'متابعة', 'cases', 'follow-up', 'visit'],
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
    key: 'fees',
    items: [
      /*
        `FIELD_INSPECTOR` is absent, and that is not a new restriction — it is
        the one `FeesController` has always enforced on `notices`, `summary`,
        `titles` and `payments`. The row simply stopped claiming otherwise.
      */
      {
        path: '/fees',
        key: 'fees',
        icon: ReceiptText,
        roles: FEE_READ_ROLES,
        keywords: ['رسم', 'مطالبة', 'فاتورة', 'دفع', 'fees', 'billing'],
      },
      // Read-only: the ledger above answers "who owes what", this answers
      // "what has been paid". An auditor lives here.
      {
        path: '/payments',
        key: 'payments',
        icon: ArrowLeftRight,
        roles: ['SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'VIEWER'],
        keywords: ['قبض', 'إيصال', 'محصّل', 'نقد', 'payments', 'transactions'],
      },
      /*
        «المستحق على عقار» — the question asked before a براءة ذمّة: what is
        still owed on a parcel, whoever's file it is on. Read-only, so every
        role that reads the ledger may ask it. `LandPlot`, not `Landmark`:
        that one is the treasury's «الأرصدة», and no two rows share an icon.
        Keeps a row of its own (NAV-08, decided 2026-11-25): a clerk asks it
        whenever a citizen asks for a براءة ذمّة. The page has no role check of
        its own, so this row is what gates it; `lib/nav.test.ts` pins both.
      */
      {
        path: '/fees/parcel',
        key: 'parcelDues',
        icon: LandPlot,
        roles: FEE_READ_ROLES,
        keywords: ['براءة ذمة', 'براءة ذمّة', 'رقم العقار', 'مستحق', 'دين', 'clearance', 'parcel', 'owed'],
      },
      /*
        What each collector still carries, and the handover into the safe.
        Under «الرسوم والجباية» since 2026-10-10, when «المناقلات والمصارفة»
        made «الخزينة» six rows: the round and its handover are the end of
        collecting, and the group's name already says الجباية. Still
        `TREASURY_READ_ROLES`, so a collector, who sees this group, does not
        see this row.
        Reading is `TREASURY_READ_ROLES`, the list `TransfersController` puts on
        `GET /treasury/transfers/custody`; receiving is `TREASURY_WORK_ROLES`
        and is gated on the page. The longest match wins (`activeNavItem`), so
        a collector's own page, `/finance/collectors/:id`, lights this row up.
      */
      {
        path: '/finance/collectors',
        key: 'collectors',
        icon: HandCoins,
        roles: TREASURY_READ_ROLES,
        keywords: ['جباة', 'جابي', 'عهدة', 'تحصيل', 'تسليم', 'استلام', 'collectors', 'custody', 'handover'],
      },
    ],
  },
  /*
    «الخزينة» — the municipality's books: where its money is, what reached it
    and what left it. The accountant's job, on `TREASURY_READ_ROLES` but for the
    recording page, which only those who record see (`TREASURY_WORK_ROLES`).
    No row, no guard: `canAccessPath` opens a path nobody listed to every role,
    which is why each treasury page has a row here.
  */
  {
    key: 'treasury',
    items: [
      /*
        The wallets and their balances. «الأرصدة» rather than «الخزينة» now that
        the group carries that name. Activating the treasury is narrower still
        (the manager) and is gated on the page itself.
      */
      {
        path: '/finance',
        key: 'treasury',
        icon: Landmark,
        roles: TREASURY_READ_ROLES,
        keywords: ['خزينة', 'صندوق', 'رصيد', 'أرصدة', 'حساب', 'نقد', 'treasury', 'safe', 'balance', 'cash'],
      },
      /*
        Recording money in that no citizen's bill brought — the Independent
        Municipal Fund, permits, rent, grants, fines — and money out on «أمر صرف»:
        one form, «قبض | صرف». Its own row, not a child of /finance: it is where an
        accountant spends the day. Only for those who record
        (`TREASURY_WORK_ROLES`, as `IncomeController` and `ExpensesController`
        enforce); a reader who reaches the address through the `/finance` prefix
        is told so on the page and sent to the register.
      */
      {
        path: '/finance/movements',
        key: 'movements',
        icon: ArrowDownUp,
        roles: TREASURY_WORK_ROLES,
        keywords: [
          'إيرادات',
          'إيراد',
          'قبض',
          'سند قبض',
          'صندوق بلدي',
          'رخص',
          'هبات',
          'غرامات',
          'نفقات',
          'صرف',
          'مصاريف',
          'فاتورة',
          'تسجيل',
          'income',
          'revenue',
          'receipt',
          'expense',
          'spending',
          'record',
        ],
      },
      /*
        Every voucher written, money in and out, as one dated list under a filter
        bar, the voucher behind each line in a side panel, and what waits on the
        head's order (split from the recording page 2026-10-12; before that the
        two were «الإيرادات» and «النفقات», each a register with its form). Every
        finance reader sees it. `also` keeps the printed vouchers, the income
        categories and the old registers' addresses (which lead here) under it.
        Cancelling and ordering are narrower and are gated on the page and by
        `IncomeController` and `ExpensesController`.
      */
      {
        path: '/finance/transactions',
        also: ['/finance/income', '/finance/expenses'],
        key: 'transactions',
        icon: ScrollText,
        roles: TREASURY_READ_ROLES,
        keywords: [
          'حركات',
          'سجل',
          'دفتر',
          'سندات',
          'أمر صرف',
          'بانتظار الأمر',
          'إيرادات',
          'نفقات',
          'transactions',
          'ledger',
          'register',
          'voucher',
          'payout',
          'payment order',
        ],
      },
      /*
        Money between the municipality's own wallets: a Whish cash-out, a bank
        deposit, funding petty cash, and المصارفة between ليرة and dollars. After
        the money in and the money out, since it is neither. Every finance reader
        sees the register, the auditor included — the review queue is theirs.
        Recording is `TREASURY_WORK_ROLES` and reviewing `TREASURY_REVIEW_ROLES`,
        gated on the pages and by `TransfersController`. A collector's handover
        stays on «الجباة والتحصيل»; it is listed here too.
      */
      {
        path: '/finance/transfers',
        key: 'transfers',
        icon: ArrowRightLeft,
        roles: TREASURY_READ_ROLES,
        keywords: ['مناقلة', 'تحويل', 'مصارفة', 'صرّاف', 'سعر الصرف', 'إيداع', 'سلفة', 'transfer', 'exchange', 'deposit', 'review'],
      },
      /*
        The day's end: each wallet counted against the books, the day closed so
        nothing more is written into it, and «تقرير الصندوق اليومي» to print
        and sign (`/finance/daily/report`, guarded by this row's prefix). Last
        in the group because it is the last thing the accountant does each day.
        Counting and closing are `TREASURY_WORK_ROLES` and reopening is
        `TREASURY_ADMIN_ROLES`, gated on the page and by `TreasuryClosingController`.
      */
      {
        path: '/finance/daily',
        key: 'dailyClose',
        icon: CalendarCheck,
        roles: TREASURY_READ_ROLES,
        keywords: ['جرد', 'إقفال', 'يومية', 'صندوق', 'عجز', 'فائض', 'تقرير يومي', 'count', 'close', 'daily', 'cash report'],
      },
    ],
  },
  /*
    Checking the work, as its own section.

    «مراجعة الجودة» was one row opening one page of four tabs, and a tab is not
    addressable: it cannot be linked from a notification, cannot be opened in a
    second window beside the register, and hides three of the four screens from
    the command palette. It became four rows and four pages, and four rows with
    the same frame became one again (NAV-03, 2026-11-25): «الجودة», whose tabs
    are addressable (`?tab=`) and whose old addresses forward to them.
    «سجل النشاطات» belongs here for
    the same reason: an auditor reading who changed what is doing this job, not
    configuring the municipality, and «النظام» is left as what it says —
    settings and accounts.

    Every quality row is held to the roles `QualityController` enforces with
    `QUALITY_REVIEWER_ROLES`. An officer's own returned records and the re-checks they
    may do are on «أرباحي والمسح الميداني» instead, so nobody is offered a
    screen that would only tell them their work is being watched.
  */
  {
    key: 'review',
    items: [
      /*
        Tabs: «اعتماد السجلات» (the queue, first), «الملاحظات», «التحقق الميداني»,
        «حسب الموظف». The four old paths are the row's own, so a link to one is
        guarded by these roles and lights this row.
      */
      {
        path: '/quality',
        key: 'quality',
        icon: ClipboardCheck,
        also: ['/quality/reviews', '/quality/findings', '/quality/checks', '/quality/officers'],
        roles: QUALITY_REVIEWER_ROLES,
        keywords: [
          'مراجعة',
          'اعتماد',
          'إعادة',
          'جودة',
          'تكرار',
          'تناقض',
          'ملاحظات',
          'تحقق',
          'عيّنة',
          'ميداني',
          'موظف',
          'أداء',
          'review',
          'approve',
          'return',
          'findings',
          'duplicates',
          'quality',
          'check',
          'sample',
          'officer',
          'performance',
        ],
      },
      {
        path: '/audit',
        key: 'audit',
        icon: ShieldCheck,
        // The two roles `AuditController` serves — the auditor is who the log is for.
        roles: AUDIT_READ_ROLES,
        keywords: ['تدقيق', 'تاريخ', 'تغييرات', 'audit', 'logs'],
      },
    ],
  },
  /*
    «الأخبار» — the municipality's News, kept on Day3ati and managed from here
    as the signed-in user (`NEWS_EDITOR_ROLES`: the administrator and the
    administrative officer, the two who have an account there). Its own group
    because it is neither the register nor the books: a screen of its own job.
    One row (NAV-05, 2026-11-25), under its own name with no heading above it:
    the two lists the articles are filed and published by, «أقسام الأخبار» and
    «ناشرو الأخبار», open from the articles page's header, and keep their
    addresses as the row's `also`, so `NEWS_EDITOR_ROLES` still guards them.
  */
  {
    roles: NEWS_EDITOR_ROLES,
    items: [
      {
        path: '/news/articles',
        key: 'news',
        icon: Newspaper,
        also: ['/news/categories', '/news/publishers'],
        roles: NEWS_EDITOR_ROLES,
        keywords: [
          'أخبار',
          'خبر',
          'نشر',
          'مقال',
          'قسم',
          'تصنيف',
          'ناشر',
          'جهة',
          'news',
          'article',
          'articles',
          'publish',
          'category',
          'categories',
          'publisher',
          'publishers',
        ],
      },
    ],
  },
  {
    key: 'system',
    items: [
      {
        path: '/settings',
        key: 'settings',
        icon: Settings,
        roles: ['SUPER_ADMIN'],
        keywords: ['ويش', 'واتساب', 'عنوان', 'دوام', 'settings', 'config'],
      },
      {
        path: '/staff',
        key: 'staff',
        icon: UsersRound,
        roles: ['SUPER_ADMIN'],
        keywords: ['موظف', 'صلاحيات', 'حساب', 'staff', 'users'],
      },
    ],
  },
];

/**
 * A page that has no row in the sidebar, and what still has to know it.
 *
 * A page whose row leaves `NAV_GROUPS` leaves with it everything that reads
 * that list: the header's crumb (`pageNavItem`) and the command palette. These
 * pages say what the row used to say, so those two keep working, and nothing
 * else does: the sidebar, `canAccessPath` and `defaultPathFor` read
 * `NAV_GROUPS` only, so a path here still opens to every role the sidebar
 * would let in (a path with no row is `/citizens`'s or `/fees`'s). `roles`
 * is who the page is for, and each page turns the others away itself.
 *
 *  - «تسجيل مواطن جديد» (NAV-02): opened from the citizens page's header, the
 *    unsurveyed worklist, a unit in the matrix, a case, and the palette.
 *  - «فواتير تأثّرت بتصحيحات» (NAV-07): opened from the fees page's header.
 *  - «أمان الحساب» (NAV-06): opened from the user menu.
 *  - «أقسام الأخبار» and «ناشرو الأخبار» (NAV-05): opened from the articles page's header.
 */
export const OFF_SIDEBAR_PAGES: ReadonlyArray<NavItem & { inPalette: boolean }> = [
  {
    path: '/citizens/new',
    key: 'registerCitizen',
    icon: UserPlus,
    // The roles `CitizenEditor` admits and `CitizenController.create` accepts, not a copy of them.
    roles: CITIZEN_RECORD_EDIT_ROLES,
    keywords: ['تسجيل', 'مواطن', 'جديد', 'إضافة', 'أسرة', 'نموذج', 'register', 'new', 'add'],
    inPalette: true,
  },
  {
    path: '/fees/corrections',
    key: 'feeCorrections',
    icon: FileWarning,
    roles: PAYMENT_REVIEW_READ_ROLES,
    keywords: ['تصحيح', 'فاتورة', 'فرق', 'مراجعة', 'corrections', 'bills', 'difference'],
    inPalette: false,
  },
  {
    path: '/news/categories',
    key: 'newsCategories',
    icon: Tags,
    roles: NEWS_EDITOR_ROLES,
    keywords: ['أخبار', 'قسم', 'تصنيف', 'news', 'category', 'categories'],
    inPalette: false,
  },
  {
    path: '/news/publishers',
    key: 'newsPublishers',
    icon: Megaphone,
    roles: NEWS_EDITOR_ROLES,
    keywords: ['أخبار', 'ناشر', 'جهة', 'news', 'publisher', 'publishers'],
    inPalette: false,
  },
  {
    path: '/account',
    key: 'account',
    icon: KeyRound,
    // Everyone has a password to change and a second factor to enrol, and it is their own.
    roles: EVERY_STAFF_ROLE,
    keywords: ['كلمة المرور', 'أمان', 'حسابي', 'مصادقة', '2fa', 'password', 'security', 'account'],
    inPalette: false,
  },
];

/** The off-sidebar pages this role is for. */
function offSidebarFor(role: string | undefined): ReadonlyArray<NavItem & { inPalette: boolean }> {
  return role ? OFF_SIDEBAR_PAGES.filter((page) => page.roles.includes(role)) : [];
}

/** The off-sidebar pages the command palette offers this role, beside the sidebar's rows. */
export function paletteOnlyItems(role: string | undefined): NavItem[] {
  return offSidebarFor(role).filter((page) => page.inPalette);
}

/**
 * What the header's crumb names for a pathname: the sidebar's row, or an
 * off-sidebar page when its address is the longer match (`/citizens/new` under
 * `/citizens`, `/account` under no row at all).
 */
export function pageNavItem(pathname: string | null, base: string, role: string | undefined): NavItem | undefined {
  const row = activeNavItem(pathname, base, role);
  if (!pathname) return row;
  const page = offSidebarFor(role)
    .map((candidate) => ({ candidate, length: matchLength(candidate, pathname, base) }))
    .filter((match) => match.length >= 0)
    .sort((a, b) => b.length - a.length)[0];
  if (!page) return row;
  return !row || page.length > matchLength(row, pathname, base) ? page.candidate : row;
}

/**
 * The groups this role may see, with empty groups dropped entirely.
 *
 * A role of `undefined` — a session still loading, or one whose claim carries
 * no role — now sees **nothing**, where it previously saw every unguarded row.
 * That inversion is the point of making `roles` required: the sidebar renders
 * before the session is read, and "we do not know who this is yet" must not be
 * the state in which the most permissive answer is given.
 */
export function visibleGroups(role: string | undefined, options: { newsEnabled?: boolean } = {}): NavGroup[] {
  if (!role) return [];
  return NAV_GROUPS
    .filter((group) => !group.roles || group.roles.includes(role))
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.roles.includes(role) &&
          // News is hidden from a municipality whose Day3ati village lacks the module. Only a definite «no»
          // hides it: while that is unknown (`undefined`) the rows stay.
          !(options.newsEnabled === false && item.path.startsWith('/news')),
      ),
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
  const known = NAV_GROUPS.flatMap((group) => group.items).some((item) => matchLength(item, pathname, base) >= 0);
  if (!known) return true;

  return Boolean(activeNavItem(pathname, base, role));
}

/**
 * How long a prefix of `pathname` a row claims: the longest of its `path` and
 * its `also` paths that the pathname is, or sits under; -1 for none.
 */
function matchLength(item: NavItem, pathname: string, base: string): number {
  let longest = -1;
  for (const path of [item.path, ...(item.also ?? [])]) {
    const href = `${base}${path}`;
    if ((pathname === href || pathname.startsWith(`${href}/`)) && path.length > longest) longest = path.length;
  }
  return longest;
}

/**
 * Which nav row a pathname belongs to — **longest match wins**.
 *
 * A plain `startsWith` lights up two rows wherever one route is a prefix of
 * another, and `/citizens` became such a prefix the moment `/citizens/:id`
 * existed. Matching on the longest candidate keeps a detail page attributed to
 * its own section rather than to whichever prefix was declared first.
 *
 * A row's `also` paths count as its own: a printed voucher under
 * `/finance/income/…` belongs to `/finance/transactions`, not to `/finance`,
 * because `/finance/income` is the longer match.
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
    .map((item) => ({ item, length: matchLength(item, pathname, base) }))
    .filter((candidate) => candidate.length >= 0)
    .sort((a, b) => b.length - a.length);
  return candidates[0]?.item;
}

/**
 * A row's name in the page's language, from `messages.nav.items` (NAV-10).
 *
 * A plain lookup, not a hook: the header, the sidebar and the palette are
 * components, but `nav.ts` is data read by plain functions and tests, and a
 * label with no placeholders needs no translator (as `audit-labels.ts` reads
 * `auditActions`). The page's own title reads the same message through
 * `useTranslations('nav.items')`.
 */
export function localizedLabel(item: NavItem, locale: string = 'ar'): string {
  return navLabel(item.key, locale);
}

/** The same lookup by key, for a page that names itself without holding its row. */
export function navLabel(key: NavKey, locale: string = 'ar'): string {
  return (locale === 'en' ? en : ar).nav.items[key];
}

export function localizedGroupLabel(group: NavGroup, locale: string = 'ar'): string {
  // '' for a group with no heading. Callers render a heading only when there is
  // one, so this never reaches the screen.
  return group.key ? (locale === 'en' ? en : ar).nav.groups[group.key] : '';
}
