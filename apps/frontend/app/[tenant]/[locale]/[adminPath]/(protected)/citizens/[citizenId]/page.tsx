'use client';

import { isValidElement, use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Archive,
  Banknote,
  Building2,
  Calendar,
  Clock3,
  Droplet,
  FileDigit,
  FileQuestion,
  FileText,
  Flag,
  Hash,
  Heart,
  Home,
  IdCard,
  MapPin,
  MessageCircle,
  Pencil,
  Phone,
  Receipt as ReceiptIcon,
  Signpost,
  StickyNote,
  Unlink,
  User,
  UserCheck,
  Users,
  Wallet,
} from 'lucide-react';
import { getLabels, isNonPersonRecord, isOwnerRecord } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenProfile,
  getMunicipalitySettings,
  getTenantConfig,
  logApiError,
} from '@/lib/api-client';
import type {
  CitizenFeeTotals,
  CitizenProfile,
  CitizenProfileLandlordOf,
  CitizenProfilePayment,
  MunicipalitySettings,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { useToast } from '@/components/ui/toast';
import { describeAssessment } from '@/lib/fee-assessment';
import { flagFieldLabel } from '@/lib/field-flags';
import { findLocatedProperty, mapHref } from '@/lib/map-link';
import { ActivityTrail } from '@/components/admin/activity-trail';
import { AUDIT_ENTITY } from '@/lib/audit-labels';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Pager } from '@/components/ui/pager';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { LandlordUnlinkDialog } from '@/components/admin/landlord-unlink-dialog';
import { CompleteRecordDialog } from '@/components/admin/complete-record-dialog';
import { DocumentList } from '@/components/admin/document-list';
import {
  CitizenMergeNotes,
  MergeWithAnotherButton,
  useCitizenMerges,
} from '@/components/admin/citizen-merges';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { formatPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { param, useUrlState } from '@/lib/use-url-state';
import { buildCitizenWelcomeMessage, buildWhatsappHref } from '@/lib/whatsapp';
import { BULK_SETTLE_ROLES, DOCUMENT_VIEW_ROLES, REFERENCE_SEND_ROLES, hasRole } from '@/lib/staff-roles';
import { fromCitizenPayment, isBulkSettleable, pageSelection, rowBlock } from '@/lib/bulk-settle';
import { useBulkSelection, type BulkSelection } from '@/lib/use-bulk-selection';
import { BillCheckbox } from '@/components/admin/bulk-settle/bill-checkbox';
import { BulkSettleBar } from '@/components/admin/bulk-settle/bulk-settle-bar';

interface FactItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: React.ReactNode;
  /** Latin-script content (numbers, phones) that must not mirror in RTL. */
  ltr?: boolean;
  /**
   * A line under the value saying how much weight it still carries.
   *
   * There are now two kinds of value on this page that look identical and are
   * not: one the register keeps asking about, and one it stored once and no
   * longer maintains — a Lebanese citizen's identity document, a household's
   * details after the file was converted to «غير مقيم في البلدة». A number
   * nobody has been asked to confirm for a year should not be read the same way
   * as this morning's phone call, and the only place to say so is next to it.
   */
  hint?: string;
}

/**
 * «لم يُسأل» — the value nobody was asked for, said out loud.
 *
 * Distinct from a fact that is simply absent (`present` drops those): there are
 * fields where the *absence itself* is the finding and hiding the row hides it.
 * اسم الأم is the one this exists for — null on every household filed before
 * migration 0044, and reading that as "this person's file differs from their
 * namesake's" is exactly the confusion the field was added to end.
 */
function NotAsked({ locale }: { locale: string }) {
  return (
    <span className="font-normal text-muted-foreground">
      {locale === 'en' ? 'Not asked' : 'لم يُسأل'}
    </span>
  );
}

/**
 * «محفوظ من تسجيل سابق — لم يعد يُطلب»: an identity document still on file.
 *
 * The register stopped asking a Lebanese citizen for one (see
 * `personalDetailsObject.identityDocType`), and deliberately did not erase the
 * real numbers already stored — an edit that no longer sends the field leaves
 * the stored value alone. So a number shown here is a number *nobody has been
 * asked to confirm since*, which is a different thing from the phone an officer
 * verified last week, and the difference matters most to whoever is about to
 * rely on it to tell two people apart. اسم الأم is what does that job now.
 *
 * Silent for a non-Lebanese person: their passport number is still asked for,
 * «إلزامي إن وجد», so it is maintained like any other field. Silent too when
 * `isLebanese` is itself unknown — this line is an assertion about the record's
 * upkeep, and there is no making one without knowing which rule it fell under.
 */
function legacyDocumentHint(citizen: CitizenProfile, locale: string): string | undefined {
  if (citizen.isLebanese !== true) return undefined;
  if (!citizen.identityDocType && !citizen.identityDocNumber) return undefined;
  return locale === 'en'
    ? 'On file from an earlier registration — no longer collected'
    : 'محفوظ من تسجيل سابق — لم يعد يُطلب';
}

/**
 * «الأسرة» — the household counts, as one list both readers share.
 *
 * Shared because the same values are shown in two places with two different
 * meanings: current, on a household file, and retained-but-unmaintained on a
 * record converted to «غير مقيم في البلدة». Building the list twice would let
 * the two drift, and it is the converted record — the rarer one — whose copy
 * nobody would notice going stale.
 */
function householdFacts(citizen: CitizenProfile, locale: string): FactItem[] {
  const en = locale === 'en';
  const labels = getLabels(locale);

  /*
    إجمالي المسجلين في القيد is worth a row only when it differs from the
    household actually living in the house — otherwise it repeats the number
    directly above it.
  */
  const splitHousehold =
    citizen.totalRegisteredMembers != null &&
    citizen.actualHouseholdMembers != null &&
    citizen.totalRegisteredMembers > citizen.actualHouseholdMembers;

  return [
    {
      icon: Heart,
      label: en ? 'Marital Status' : 'الحالة الاجتماعية',
      value: citizen.maritalStatus
        ? (labels.maritalStatus?.[citizen.maritalStatus as never] ?? citizen.maritalStatus)
        : undefined,
    },
    {
      icon: Users,
      label: en
        ? 'Family Members (Living in House)'
        : 'عدد أفراد الأسرة (المقيمين في المنزل)',
      value: (citizen.actualHouseholdMembers ?? citizen.totalRegisteredMembers)?.toString(),
    },
    ...(splitHousehold
      ? [
          {
            icon: Users,
            label: en ? 'Total Registered (Civil Record)' : 'إجمالي المسجلين في القيد',
            value: citizen.totalRegisteredMembers!.toString(),
          },
        ]
      : []),
  ];
}

/**
 * What an owner record — «غير مقيم في البلدة», «تركة», «جهة أو وقف» — still
 * holds from when it was a household.
 *
 * Nothing is erased by the conversion — the edit form stops asking and the
 * server stops writing these columns, and the values filed before it stay
 * (`citizenColumnsForEdit`). That is the right call for data and the wrong one
 * for a page that renders them among the maintained fields, because a صفة
 * الإقامة that has not been asked about since the record became an owner's
 * record is not this person's صفة الإقامة — it is a fact about a household file
 * that no longer exists, and «صفة الإقامة» offers no true answer for someone
 * living in Abidjan anyway.
 *
 * So: kept, shown, closed by default, and labelled for what it is. Absent
 * entirely on a record that was never a household, which is most of them.
 */
function RetainedHouseholdSection({
  citizen,
  locale,
}: {
  citizen: CitizenProfile;
  locale: string;
}) {
  const tKind = useTranslations('citizenKind');
  // Any record that is not a household — a converted file keeps what it held (0076 too).
  if (!isOwnerRecord(citizen.residence)) return null;

  const en = locale === 'en';
  const labels = getLabels(locale);
  const kind = (labels.citizenResidence as Record<string, string>)[citizen.residence ?? ''] ?? String(citizen.residence);

  const identity = present([
    {
      icon: User,
      label: en ? "Mother's Full Name" : 'اسم الأم وشهرتها',
      value: citizen.motherName ?? undefined,
    },
    {
      icon: User,
      label: en ? 'Gender' : 'الجنس',
      value: labels.gender[citizen.gender as never] ?? citizen.gender,
    },
    {
      icon: Droplet,
      label: en ? 'Blood Type' : 'فئة الدم',
      value: citizen.bloodType
        ? (labels.bloodType?.[citizen.bloodType as never] ?? citizen.bloodType)
        : undefined,
    },
    {
      icon: Flag,
      label: en ? 'Nationality' : 'الجنسية',
      value: citizen.nationality,
    },
    {
      icon: Home,
      label: en ? 'Residency Status' : 'صفة الإقامة',
      value: labels.residentStatus[citizen.residentStatus as never] ?? citizen.residentStatus,
    },
    {
      icon: IdCard,
      label: en ? 'ID Document' : 'وثيقة الإثبات',
      value: citizen.identityDocNumber,
      ltr: true,
    },
    {
      icon: FileDigit,
      label: en ? 'Civil Record (Sijil) No.' : 'رقم السجل',
      value: citizen.civilRecordNumber,
      ltr: true,
    },
    {
      icon: FileDigit,
      label: en ? 'Residency Permit No.' : 'رقم الإقامة',
      value: citizen.residencyNumber,
      ltr: true,
    },
  ]);

  const household = present(householdFacts(citizen, locale));
  if (identity.length === 0 && household.length === 0) return null;

  return (
    <CollapsibleSection
      id="retained"
      title={en ? 'Kept from an Earlier Household File' : 'بيانات محفوظة من ملف أسرة سابق'}
      icon={Archive}
      defaultOpen={false}
      summary={
        <span className="text-muted-foreground">
          {identity.length + household.length} {en ? 'fields' : 'حقلاً'}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg border bg-muted/20 p-3 text-sm leading-relaxed text-muted-foreground">
          {tKind('retainedNote', { kind })}
        </p>
        {/* One section above the other, split by the same coloured rule the
            property cards use between their sections (`SECTION_RULE`, spelled
            out here because Tailwind only generates classes written literally). */}
        <div className="[&>*+*]:border-t-2 [&>*+*]:border-primary/30 [&>*+*]:pt-3">
          <FactSection title={en ? 'Identity' : 'الهوية'} facts={identity} />
          <FactSection title={en ? 'Household' : 'الأسرة'} facts={household} />
        </div>
      </div>
    </CollapsibleSection>
  );
}

/**
 * Drops the facts this citizen has no value for.
 *
 * Filtering the *list* rather than having each field render itself as null is
 * what keeps the grids aligned: a self-nulling field still occupies no cell,
 * so the ones after it slide into different columns for every citizen, and no
 * two profiles line up the same way. Filtering first means the grid only ever
 * receives cells it will actually fill.
 */
function present(facts: FactItem[]): FactItem[] {
  return facts.filter((fact) => fact.value != null && fact.value !== '');
}

/**
 * One row on a منشأة card: label at the inline start, value at the inline end,
 * a hairline under it, the same padding as every other row on the card.
 *
 * Declared once rather than repeated, because "equal padding for all rows" is
 * a property of the card that three copies of a class string do not keep.
 */
const UNIT_ROW =
  'flex flex-wrap items-baseline justify-between gap-x-4 border-b border-border/50 py-2 last:border-0';

/**
 * A responsive grid of cards that stops before it becomes a scroll.
 *
 * One per منشأة means a household with twelve flats gets twelve cards, and
 * twelve of anything below «الرسوم والمدفوعات» pushes «سجل الموظفين» off the
 * end of a phone. Six is two full rows on a laptop and one on a wide screen —
 * enough to see the shape of what they hold — and the rest are one tap away
 * with the count on the button, so nobody has to wonder whether the list ended
 * or was cut.
 *
 * Nothing is hidden from a browser's find-in-page that was not already: the
 * cards beyond the cap are not rendered, the same as any paginated list. The
 * count on the button is what tells a reader to open it.
 *
 * ## The columns follow the count
 *
 * A fixed two- or three-column grid left one card in a half-width box beside
 * nothing, and four as three-and-an-orphan. So the shape is chosen from how
 * many cards are shown, and no row is ever left part-empty:
 *
 *   1 → one card, the full width
 *   2 → two halves
 *   3 → three across on a wide screen
 *   4 and up → two per row; with an odd count the last card takes the row
 *
 * Responsive underneath: one card per row on a phone, at most two from `md`
 * (a tablet, or a laptop with the sidebar open), and three only from `xl`,
 * where a third of the content column is still wide enough for a card's
 * label-and-value rows.
 */
function CardGrid({
  items,
  locale,
  initial = 6,
}: {
  items: React.ReactNode[];
  locale: string;
  initial?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const en = locale === 'en';
  const hidden = items.length - initial;
  const shown = showAll ? items : items.slice(0, initial);
  const count = shown.length;

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'grid gap-3',
          count === 2 && 'md:grid-cols-2',
          count === 3 && 'md:grid-cols-2 xl:grid-cols-3',
          count >= 4 && 'md:grid-cols-2',
        )}
      >
        {shown.map((item, index) => {
          // The odd card out on a two-column row takes the whole row. With
          // three, that is only until `xl`, where all three fit across.
          const loneLast = index === count - 1 && count >= 3 && count % 2 === 1;
          return (
            <div
              key={isValidElement(item) && item.key != null ? item.key : index}
              className={cn(
                'min-w-0',
                loneLast && (count === 3 ? 'md:col-span-2 xl:col-span-1' : 'md:col-span-2'),
              )}
            >
              {item}
            </div>
          );
        })}
      </div>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-full sm:w-auto"
          onClick={() => setShowAll((open) => !open)}
        >
          {showAll
            ? en
              ? 'Show fewer'
              : 'عرض أقل'
            : en
              ? `Show all ${items.length}`
              : `عرض الكل (${items.length})`}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One citizen and everything they have filed.
 *
 * The route is tenant- and admin-path-scoped (`/{tenant}/{locale}/{adminPath}/
 * citizens/{id}`) rather than a bare `/citizens/{id}`. Two reasons, both
 * structural: a citizen id alone does not say which municipality's schema to
 * read — the tenant boundary in this system is the database connection, not a
 * WHERE clause — and this page renders identity-document numbers and residency
 * status, which belong behind the same obscure staff path and role guard as
 * the rest of the portal.
 */
export default function CitizenProfilePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; citizenId: string }>;
}) {
  const { tenant, locale, adminPath, citizenId } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const tKind = useTranslations('citizenKind');

  const [citizen, setCitizen] = useState<CitizenProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | undefined>();
  /** «استكمال البيانات الناقصة» — always on the newest registration. */
  const [completing, setCompleting] = useState(false);
  const toast = useToast();
  /** Printed on the receipt header — the tenant config is the only source. */
  const [municipalityName, setMunicipalityName] = useState('');
  /** Office numbers printed on a receipt — see إعدادات البلدية. */
  const [settings, setSettings] = useState<MunicipalitySettings | null>(null);

  /** Mirrors the server's write roles; the server is the enforcement. */
  const canEdit =
    role === 'SUPER_ADMIN' || role === 'FIELD_INSPECTOR' || role === 'ADMINISTRATIVE_OFFICER';
  /** Settling a payment belongs to the money roles server-side (`@Roles` on the
   *  fees controller), so offering it to an inspector would only earn a 403. */
  const canManage =
    role === 'SUPER_ADMIN' || role === 'COLLECTOR' || role === 'ACCOUNTANT';

  const reload = useCallback(async () => {
    if (!token) return;
    setCitizen(await getCitizenProfile(tenant, token, citizenId));
  }, [tenant, token, citizenId]);

  /** «دمج ملفين» — SUPER_ADMIN's alone; the server is the enforcement. */
  const canMerge = role === 'SUPER_ADMIN';
  /** The attachments open through the signed-URL route, which refuses «مشاهد فقط». */
  const canOpenDocuments = hasRole(DOCUMENT_VIEW_ROLES, role);
  /** The WhatsApp welcome carries the رقم مرجعي, which «مشاهد فقط» is never given. */
  const canSendReference = hasRole(REFERENCE_SEND_ROLES, role);
  const { merges, reload: reloadMerges } = useCitizenMerges(tenant, token, citizenId);

  /*
    «تسديد الفواتير المحددة» — `BULK_SETTLE_ROLES`, as the route; the server is
    the enforcement. Held here rather than in the fees panel because the bar and
    the dialog sit at the page's root: the panel folds (`CollapsibleSection`
    clips its content), and a sticky bar inside it would hold nowhere.
  */
  const canBulkSettle = hasRole(BULK_SETTLE_ROLES, role);
  const bulkSelection = useBulkSelection();
  const { reconcile: reconcileBulk } = bulkSelection;
  // Each read of the file drops a ticked bill that has been paid, or sent for review, since.
  useEffect(() => {
    if (!citizen) return;
    reconcileBulk(
      citizen.payments.map((row) => ({ bill: fromCitizenPayment(citizen, row), settleable: isBulkSettleable(row) })),
    );
  }, [citizen, reconcileBulk]);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role);

    // Public endpoint, and non-blocking: a failed config fetch must not stop
    // the profile rendering. It only supplies the name printed on a receipt,
    // which falls back to the tenant slug.
    getTenantConfig(tenant)
      .then((config) => setMunicipalityName(config.nameAr || config.name))
      .catch(() => setMunicipalityName(tenant));

    // Same non-blocking treatment as the config: a receipt without the office
    // numbers is still a valid receipt.
    getMunicipalitySettings(tenant, session.accessToken)
      .then(setSettings)
      .catch(() => setSettings(null));

    getCitizenProfile(tenant, session.accessToken, citizenId)
      .then(setCitizen)
      .catch((caught: unknown) => {
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        setError(
          caught instanceof ApiRequestError && caught.status === 404
            ? (locale === 'en' ? 'No citizen found with this ID.' : 'لا يوجد مواطن بهذا المعرّف.')
            : (locale === 'en' ? 'Failed to load citizen profile.' : 'تعذّر تحميل ملف المواطن.'),
        );
      });
  }, [tenant, base, citizenId, router, locale]);

  if (error) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive">
          {error}
        </p>
        <Link href={`${base}/dashboard`} className={buttonVariants({ variant: 'outline' })}>
          {locale === 'en' ? 'Back to Dashboard' : 'رجوع إلى اللوحة'}
        </Link>
      </div>
    );
  }

  if (!citizen) {
    return (
      <LoadingState fullHeight />
    );
  }

  const labels = getLabels(locale);
  const en = locale === 'en';

  /*
    «غير مقيم في البلدة» — a short record, not a household file.

    It decides what this page is allowed to present as current, and that is a
    stronger statement than "which fields are filled". A record converted from a
    household keeps every household column it was filed with — the edit form
    stops asking and the server stops writing them (`citizenColumnsForEdit`),
    and nothing is erased. So the values are still there to render, and
    rendering them beside the maintained ones would put a blood type nobody has
    confirmed since the conversion on the same footing as the phone number an
    officer verified this week. They go into «بيانات محفوظة» below instead,
    which says what they are.
  */
  /** Not a household: «غير مقيم في البلدة», «تركة» or «جهة أو وقف» (0076). */
  const isNonResident = isOwnerRecord(citizen.residence);
  const nonPerson = isNonPersonRecord(citizen.residence) ? citizen.residence : null;

  // What they hold now — a tenancy they left is history, not a property.
  const propertyCount = citizen.registrations.reduce(
    (total, registration) =>
      total + registration.properties.filter((property) => !property.endedAt).length,
    0,
  );

  /**
   * Whether any registration is carrying unverified fields.
   *
   * The «العقارات» fold is what closed over «يتطلب مراجعة» and its
   * «استكمال البيانات الناقصة» button — the banner is the one thing on this
   * page that says the record below it should not be read at face value, and a
   * section that arrives shut says the opposite. So the fold is conditional:
   * put away for a file with nothing outstanding, open for the file that is
   * the reason this queue exists.
   */

  const locatedProperty = findLocatedProperty(
    citizen.registrations.flatMap((registration) =>
      registration.properties.filter((property) => !property.endedAt),
    ),
  );

  const waMessage = buildCitizenWelcomeMessage({
    fullName: citizen.fullName,
    gender: citizen.gender,
    referenceNumber: citizen.referenceNumber,
    municipalityName,
  });
  const waHref = canSendReference ? buildWhatsappHref(citizen.whatsapp || citizen.phone, waMessage) : null;


  /*
    The identity facts, built once and read by the rail below.

    Assembled here rather than inline in the JSX because the rail renders them
    in one place now instead of three, and a fact list interleaved with layout
    is a fact list nobody can see the shape of.
  */
  const identityFacts: FactItem[] = isNonResident
    ? [
        { icon: User, label: en ? 'Name' : 'الاسم', value: citizen.fullName },
        /*
          Where they live, in the identity block rather than under «التواصل» —
          on this kind of record it is not a way to reach them, it is the fact
          that defines the record. Law 60/1988 Art. 14 wants the occupancy
          notice to name the occupant *and where they live*, and this is that.
          An estate or an institution lives nowhere.
        */
        ...(nonPerson
          ? []
          : [
              {
                icon: Home,
                label: en ? 'Lives in' : 'مكان الإقامة',
                value: citizen.residencePlace ?? undefined,
              },
            ]),
      ]
    : [
        { icon: User, label: en ? 'Name' : 'الاسم', value: citizen.fullName },
        /*
          Beside the name, because it is part of how this person is named — and
          because it is the only thing on this card that separates them from a
          namesake now that no identity document is asked.

          Rendered as «لم يُسأل» rather than dropped when null, which is what a
          household filed before migration 0044 holds. A row that vanishes is
          indistinguishable from a field this page forgot; the visible «لم
          يُسأل» is the difference between "we did not ask" and "she has no
          name", and it is the prompt to ask next time the door opens.
        */
        {
          icon: User,
          label: en ? "Mother's Full Name" : 'اسم الأم وشهرتها',
          value: citizen.motherName ?? <NotAsked locale={locale} />,
        },
        {
          icon: User,
          label: en ? 'Gender' : 'الجنس',
          value: labels.gender[citizen.gender as never] ?? citizen.gender,
        },
        {
          icon: Droplet,
          label: en ? 'Blood Type' : 'فئة الدم',
          value: citizen.bloodType
            ? (labels.bloodType?.[citizen.bloodType as never] ?? citizen.bloodType)
            : undefined,
        },
        { icon: Flag, label: en ? 'Nationality' : 'الجنسية', value: citizen.nationality },
        {
          icon: Home,
          label: en ? 'Residency Status' : 'صفة الإقامة',
          value: labels.residentStatus[citizen.residentStatus as never] ?? citizen.residentStatus,
        },
        {
          icon: IdCard,
          label: en ? 'ID Document Type' : 'نوع وثيقة الإثبات',
          value: labels.identityDocType[citizen.identityDocType as never] ?? citizen.identityDocType,
          hint: legacyDocumentHint(citizen, locale),
        },
        {
          icon: FileDigit,
          label: en ? 'Document Number' : 'رقم الوثيقة',
          value: citizen.identityDocNumber,
          ltr: true,
          hint: legacyDocumentHint(citizen, locale),
        },
        citizen.isLebanese
          ? {
              icon: FileDigit,
              label: en ? 'Civil Record (Sijil) No.' : 'رقم السجل',
              value: citizen.civilRecordNumber,
              ltr: true,
            }
          : {
              icon: FileDigit,
              label: en ? 'Residency Permit No.' : 'رقم الإقامة',
              value: citizen.residencyNumber,
              ltr: true,
            },
      ];

  const contactFacts: FactItem[] = [
    {
      icon: Phone,
      label: en ? 'Phone' : 'الهاتف',
      /*
        «لا يملك رقم هاتف» is an answer, not a gap: said in place of the number,
        so the row does not vanish as if nobody had asked.
      */
      value: citizen.phone ? (
        <PhoneLink phone={citizen.phone} locale={locale} />
      ) : citizen.hasNoPhone ? (
        <span className="text-muted-foreground">{labels.citizenField.hasNoPhone}</span>
      ) : null,
    },
    {
      icon: MessageCircle,
      label: en ? 'WhatsApp' : 'واتساب',
      value: citizen.whatsapp ? (
        <WhatsAppPhoneLink phone={citizen.whatsapp} message={canSendReference ? waMessage : undefined} />
      ) : null,
    },
    // A relative's number, labelled as a relative's — never read as the citizen's own.
    ...(!isNonResident && citizen.contactPhone
      ? [
          {
            icon: Phone,
            label: labels.citizenField.contactPhone,
            value: <PhoneLink phone={citizen.contactPhone} locale={locale} />,
          },
        ]
      : []),
    // Who holds the keys here, for an owner who is not here — or who speaks for the heirs, or the body.
    ...(isNonResident
      ? [
          {
            icon: User,
            label:
              nonPerson === 'ESTATE'
                ? tKind('estateRepresentative')
                : nonPerson === 'INSTITUTION'
                  ? tKind('institutionRepresentative')
                  : en
                    ? 'Local contact'
                    : 'جهة الاتصال المحلية',
            value: citizen.localContactName ?? undefined,
          },
          {
            icon: Phone,
            label: nonPerson ? tKind('representativePhone') : en ? 'Local contact phone' : 'هاتف جهة الاتصال',
            value: citizen.localContactPhone ? (
              <PhoneLink phone={citizen.localContactPhone} locale={locale} />
            ) : null,
          },
        ]
      : []),
  ];

  const registrationFacts: FactItem[] = [
    {
      icon: Hash,
      label: en ? 'Reference Number' : 'الرقم المرجعي',
      value: citizen.referenceNumber,
      ltr: true,
    },
    /*
      نوع الملف, stated rather than left to be inferred from the badge beside
      the name. It decides which fields this record is ever asked for, so a
      reviewer wondering why there is no blood type should find the answer
      written down, not have to know it.
    */
    {
      icon: Signpost,
      label: en ? 'Record Type' : 'نوع الملف',
      value:
        labels.citizenResidence[
          (citizen.residence ?? 'RESIDENT') as keyof typeof labels.citizenResidence
        ],
    },
    {
      icon: Calendar,
      label: en ? 'First Registered' : 'تاريخ أول تسجيل',
      value: formatDate(citizen.registeredAt),
    },
  ];

  /*
    ## The layout

    A two-column reading page, not a stack of closed drawers.

    What this replaced: «البيانات الشخصية»، «الرسوم والمدفوعات» and «العقارات»
    were three accordions, all three shut on arrival. Every visit to this page
    — the counter clerk checking a phone number, the collector checking a
    balance, the inspector checking which flat — began with the same two or
    three clicks, and the summary line on a closed section was the compensation
    for that rather than a feature. A record that decides what somebody is
    charged should not open folded.

    So: who this is and how to reach them lives in a rail that stays put while
    the long things scroll beside it, and the long things — the ledger, the
    properties, the trail — are simply open. The rail is `lg:sticky` only where
    there is height to hold it; on a phone it is the first thing on the page,
    which is also the right order there.

    The fold is kept for exactly the two blocks that earn it: «بيانات محفوظة»,
    which is by definition not current, and the activity trail, which is long
    and is read on purpose rather than in passing.
  */
  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink
        fallbackHref={`${base}/citizens`}
        label={locale === 'en' ? 'Back' : 'رجوع'}
        className="text-sm"
      />

      {/* ── Identity bar ────────────────────────────────────────────── */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {citizen.fullName}
            </h1>

            {/*
              الرقم المرجعي and الهاتف used to repeat here, under the name. They
              were promoted into the headline back when the facts lived in a
              folded section three clicks away — which they no longer do:
              «بيانات التسجيل» states the reference and «التواصل» states the
              phone, both labelled, both on the first screen. Two copies of the
              same number a hand's width apart is not emphasis, it is a reader
              checking whether they are the same number.
            */}
            <div className="flex flex-wrap items-center gap-1.5">
              {isNonResident ? (
                <Badge variant="soft-info">
                  {labels.citizenResidence[citizen.residence as keyof typeof labels.citizenResidence]}
                  {!nonPerson && citizen.residencePlace ? ` — ${citizen.residencePlace}` : ''}
                </Badge>
              ) : null}
              {/*
                A deactivated record reads exactly like a live one otherwise —
                same name, same properties, same outstanding balance — and it is
                the one thing about it that changes what a clerk should do with
                what follows. ملفّي has said this to the citizen since it was
                built; the staff page that decides things never did.
              */}
              {!citizen.isActive ? (
                <Badge variant="soft-warning">{en ? 'Deactivated record' : 'سجل معطّل'}</Badge>
              ) : null}
              {/*
                الجنس, فئة الدم and صفة الإقامة used to sit here too. They are
                facts about the person, and «الهوية» — now directly below the
                headline rather than off in a rail — states all three with their
                own labels. A pill reading «ذكر» beside a pill reading «من سكان
                الضيعة» makes the reader work out what each one is answering; the
                card says «الجنس: ذكر» and asks nothing of them.

                What stays is the two that are not facts but standing: a record
                that is deactivated, and an owner who does not live here. Both
                change what a clerk should do with everything under them, which
                is what earns a place in the headline.
              */}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* A file folded into another is edited on the file that stays. */}
            {canEdit && !merges?.into ? (
              <Link href={`${base}/citizens/${citizen.id}/edit`} className={buttonVariants()}>
                <Pencil className="size-4" aria-hidden />
                {locale === 'en' ? 'Edit Details' : 'تعديل البيانات'}
              </Link>
            ) : null}

            {/* What this person owns and lives in — its own page since it left this one. */}
            <Link
              href={`${base}/citizens/${citizen.id}/properties`}
              className={buttonVariants({ variant: 'outline' })}
            >
              <Building2 className="size-4" aria-hidden />
              {locale === 'en' ? 'Properties' : 'العقارات'}
            </Link>

            {/*
              One button carries a word, the rest carry an icon.

              All three used to be full-width labelled buttons, one of them
              emerald, so the header offered three things of equal apparent
              weight and spent two accent colours doing it. «تعديل البيانات» is
              the one an officer came here to press; sending a رقم مرجعي over
              واتساب and jumping to the map are things they occasionally reach
              for. Demoting those two to icons says which is which without
              removing either, and the name each one has kept in `title` is also
              read out by a screen reader through `sr-only`.
            */}
            {waHref ? (
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'icon' })}
                title={
                  locale === 'en'
                    ? 'Send reference number and registration confirmation via WhatsApp'
                    : 'إرسال الرقم المرجعي وتأكيد التسجيل عبر واتساب'
                }
              >
                <MessageCircle className="size-4" aria-hidden />
                <span className="sr-only">
                  {locale === 'en' ? 'Send via WhatsApp' : 'إرسال عبر واتساب'}
                </span>
              </a>
            ) : null}

            {/*
              «دمج مع ملف آخر» — an icon beside the map, not a word beside
              «تعديل البيانات»: it is the rare administrator's action, and the
              dialog behind it says everything before anything happens. Not on
              a file already folded away, nor a deactivated one.
            */}
            {canMerge && token && citizen.isActive && !merges?.into ? (
              <MergeWithAnotherButton
                citizenId={citizen.id}
                tenant={tenant}
                token={token}
                locale={locale}
                onMerged={(result) => {
                  toast.success(en ? 'The two files were merged.' : 'دُمج الملفان.');
                  if (result.keepId === citizen.id) {
                    void reload();
                    void reloadMerges();
                  } else {
                    router.push(`${base}/citizens/${encodeURIComponent(result.keepId)}`);
                  }
                }}
              />
            ) : null}

            <Link
              href={locatedProperty ? mapHref(base, locatedProperty) : `${base}/map`}
              className={buttonVariants({ variant: 'outline', size: 'icon' })}
              title={
                locatedProperty
                  ? locale === 'en'
                    ? 'View on map'
                    : 'عرض على الخريطة'
                  : locale === 'en'
                    ? 'No property location has been mapped for this citizen yet'
                    : 'لم يتم تحديد موقع أي عقار لهذا المواطن بعد'
              }
            >
              <MapPin className="size-4" aria-hidden />
              <span className="sr-only">
                {locale === 'en' ? 'View on Map' : 'عرض على الخريطة'}
              </span>
            </Link>
          </div>
        </div>

        <CitizenMergeNotes
          merges={merges}
          citizenId={citizen.id}
          base={base}
          tenant={tenant}
          token={token}
          locale={locale}
          canMerge={canMerge}
          onChanged={() => {
            toast.success(en ? 'The merge was undone.' : 'تمّ التراجع عن الدمج.');
            void reload();
            void reloadMerges();
          }}
        />

        {/*
          ── At a glance ──

          The three numbers somebody came to this page for, answered before any
          section is read. The balance leads because it is the only one of the
          three that is ever urgent, and it carries the same tone the ledger
          gives it — destructive where something is overdue, emerald where there
          is nothing owed — so the page never says «لا مستحقات» in the colour of
          a debt.
        */}
        {/*
          One strip, divided — not three floating cards. Three bordered boxes
          carrying three short values read as three separate things to deal
          with; ruled cells of one panel read as one summary line, which is what
          they are. `border-s` and not `border-l`, so the rules fall between the
          cells in Arabic as well as English.
        */}
        <dl className="grid grid-cols-1 overflow-hidden rounded-lg border bg-card sm:grid-cols-3 [&>*+*]:border-t sm:[&>*+*]:border-s sm:[&>*+*]:border-t-0">
          <StatTile
            icon={Wallet}
            label={en ? 'Outstanding' : 'الرصيد المستحق'}
            tone={citizen.fees.overdueTotal > 0 ? 'bad' : 'plain'}
            value={
              citizen.fees.outstandingTotal > 0 ? (
                <Money amount={citizen.fees.outstandingTotal} />
              ) : (
                <span>{en ? 'Nothing due' : 'لا مستحقات'}</span>
              )
            }
            hint={
              citizen.fees.overdueTotal > 0
                ? en
                  ? 'Includes overdue'
                  : 'منها متأخرات'
                : undefined
            }
          />
          <StatTile
            icon={Building2}
            label={en ? 'Properties' : 'العقارات'}
            value={propertyCount}
            hint={en ? 'Currently held' : 'قائمة حالياً'}
          />
          <StatTile
            icon={FileText}
            label={en ? 'Applications' : 'الطلبات'}
            value={citizen.registrations.length}
            hint={formatDate(citizen.registeredAt)}
          />
        </dl>
      </header>

      <div className="space-y-5">
        {/*
          ── Who this is ──

          The identity cards run across the top, full width, instead of down a
          sticky rail beside the record. A rail made them a sidebar — context you
          read past on the way to the file — when they answer «مين هيدا؟», which
          is the first question anyone opening this page has and the one to
          settle before the page starts listing what the person owns and owes.

          The cards stretch to one height, which is grid's default and why there
          is no `items-start` here. «الهوية» carries nine facts and «التواصل»
          two, so the short ones do carry empty space — but a row whose cards all
          end on the same line reads as one band of identity, and four different
          bottom edges read as four things that happened to land near each other.
        */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <InfoCard icon={IdCard} title={en ? 'Identity' : 'الهوية'}>
            <FactList facts={identityFacts} />
          </InfoCard>

          {present(contactFacts).length > 0 ? (
            <InfoCard icon={Phone} title={en ? 'Contact' : 'التواصل'}>
              <FactList facts={contactFacts} />
            </InfoCard>
          ) : null}

          {/*
            «الأسرة» belongs to a household file. A non-resident record is asked
            for none of it (`nonResidentOwnerPersonalSchema`), so whatever a
            converted record still holds is shown below under «بيانات محفوظة»,
            where it is labelled as kept rather than current.
          */}
          {!isNonResident && present(householdFacts(citizen, locale)).length > 0 ? (
            <InfoCard icon={Users} title={en ? 'Household' : 'الأسرة'}>
              <FactList facts={householdFacts(citizen, locale)} />
            </InfoCard>
          ) : null}

          <InfoCard icon={Signpost} title={en ? 'Registration' : 'بيانات التسجيل'}>
            <FactList facts={registrationFacts} />
          </InfoCard>
        </section>

        {/*
          Outside the grid: «بيانات محفوظة» is a full-width note about the cards
          above it — values a converted record still holds that the form no
          longer asks for — and not a fifth card standing among them as though
          it were current.
        */}
        <RetainedHouseholdSection citizen={citizen} locale={locale} />

        {/* ── Main: what the record says ──────────────────────────── */}
        <div className="space-y-5">
          <FeesPanel
            citizen={citizen}
            payments={citizen.payments}
            fees={citizen.fees}
            canManage={canManage}
            selection={canBulkSettle ? bulkSelection : null}
            municipalityName={municipalityName}
            governorate={settings?.governorate}
            councilDecisionRef={settings?.councilDecisionRef}
            district={settings?.district}
            contactPhone={settings?.contactPhone}
            officeWhatsapp={settings?.whatsappNumber}
            locale={locale}
          />

          {/*
            «العقارات» lives on its own page now — the button in the header —
            so the file no longer carries a folded copy of it.

            What stays is what only that section held about the *application*
            rather than the property: the fields left unconfirmed, with the way
            to complete them; what the officer wrote down; the scanned papers.
            Shown open, and only on an application that has any of them, so a
            settled file shows nothing here at all.
          */}
          {citizen.registrations.map((registration, registrationIndex) =>
            registration.flags.length > 0 || registration.notes || registration.documents.length > 0 ? (
              <Card key={registration.id} className="overflow-hidden">
                <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 border-b bg-muted/30 py-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <FileText className="size-4 text-muted-foreground" aria-hidden />
                    {locale === 'en' ? 'Application' : 'الطلب'}
                    <bdi dir="ltr" className="font-mono">{registration.referenceNumber}</bdi>
                  </CardTitle>
                  <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Calendar className="size-3.5" aria-hidden />
                    {formatDate(registration.submittedAt)}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                  {registration.flags.length > 0 ? (
                    <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 p-3">
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
                        <FileQuestion className="size-4 shrink-0" aria-hidden />
                        {locale === 'en'
                          ? `Requires review — ${registration.flags.length} unverified field(s)`
                          : `يتطلب مراجعة — ${registration.flags.length} حقلاً غير مؤكَّد`}
                      </p>
                      {/*
                        One field per row — the field at the start, why it was
                        left open at the far edge — the way «ملخص المنشأة» and
                        the building page read, rather than a dash-joined line
                        per field that left the other half of the box empty.
                      */}
                      <SummaryList className="divide-warning/25">
                        {registration.flags.map((flag) => (
                          <SummaryRow
                            key={flag.path}
                            label={flagFieldLabel(flag.path, locale)}
                            className="font-normal text-muted-foreground"
                          >
                            {flag.reason}
                          </SummaryRow>
                        ))}
                      </SummaryList>
                      {/*
                        Two ways on, and which is offered depends on the record.

                        «استكمال البيانات الناقصة» fills the gaps in place and
                        is what this banner is actually for: the commonest work
                        here is one value somebody phoned back with, and sending
                        a clerk into the four-step form to type it is what left
                        this queue unworked. It is offered only on the newest
                        registration because that is the one the form owns —
                        `/citizens/:id/form` returns the latest claim, so a
                        dialog opened on an older one would silently write the
                        answers onto a different record.

                        The full form stays alongside it rather than being
                        replaced. Some gaps are not one value: «لم نتمكن من جرد
                        وحدات المبنى» is answered by going through the building,
                        and a duplicate verdict is answered by the review the
                        edit form carries.
                      */}
                      {canEdit ? (
                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          {registrationIndex === 0 ? (
                            <button
                              type="button"
                              onClick={() => setCompleting(true)}
                              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {locale === 'en'
                                ? 'Fill in the missing details'
                                : 'استكمال البيانات الناقصة'}
                            </button>
                          ) : null}
                          <Link
                            href={`${base}/citizens/${citizen.id}/edit`}
                            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                          >
                            {locale === 'en' ? 'Open the full form' : 'فتح نموذج التعديل الكامل'}
                          </Link>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/*
                    «ملاحظات» — what the last officer learned by standing there.

                    Under the flags and above the properties. It is not a
                    warning, so it does not wear the warning colours the flag
                    block does; it is frequently the most useful line on the
                    page for whoever is about to knock on this door, so it is
                    not buried under the property cards either.

                    `whitespace-pre-line` because a note is written as a note:
                    line breaks the officer typed are part of what they said.
                  */}
                  {registration.notes ? (
                    <div className="space-y-1 rounded-lg border bg-muted/20 p-3">
                      <p className="flex items-center gap-1.5 text-sm font-semibold">
                        <StickyNote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        {locale === 'en' ? 'Notes' : 'ملاحظات'}
                      </p>
                      <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                        {registration.notes}
                      </p>
                    </div>
                  ) : null}
                  {registration.documents.length > 0 ? (
                  <div className="space-y-2">
                    <SubHeading icon={FileText}>
                      {locale === 'en'
                        ? `Attachments ${registration.documents.length > 0 ? `(${registration.documents.length})` : ''}`
                        : `المرفقات ${registration.documents.length > 0 ? `(${registration.documents.length})` : ''}`}
                    </SubHeading>
                    <DocumentList
                      documents={registration.documents}
                      tenant={tenant}
                      base={base}
                      token={token}
                      locale={locale}
                      canOpen={canOpenDocuments}
                      emptyLabel={
                        locale === 'en' ? 'No attachments for this application.' : 'لا توجد مرفقات لهذا الطلب.'
                      }
                    />
                  </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null,
          )}

          {citizen.landlordOf && citizen.landlordOf.length > 0 ? (
            <LandlordOfSection
              cards={citizen.landlordOf}
              base={base}
              tenant={tenant}
              token={token}
              canEdit={canEdit}
              onChanged={() => void reload()}
              locale={locale}
            />
          ) : null}

          {/* «ربط مالك بمستأجر», «تسجيل مواطن» and the rest are filed against
              the `User` row this page is showing — see AUDIT_ENTITY.citizen. */}
          <ActivityTrail
            tenant={tenant}
            locale={locale}
            base={base}
            entityType={AUDIT_ENTITY.citizen}
            entityId={citizenId}
          />
        </div>
      </div>

      {/* Mounted once at the page root rather than inside the registration
          card that opens it: the card sits in a `CollapsibleSection`, and a
          dialog rendered inside a section the clerk can fold would unmount
          mid-edit. It always edits the newest registration — see the banner. */}
      <CompleteRecordDialog
        open={completing}
        onOpenChange={setCompleting}
        tenant={tenant}
        base={base}
        token={token}
        citizenId={citizenId}
        citizenName={citizen.fullName}
        locale={locale}
        onSaved={() => void reload()}
      />

      {/* «تسديد الفواتير المحددة» — sticky at the foot while a bill is ticked; a direct child of the root. */}
      {canBulkSettle && token ? (
        <BulkSettleBar
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          selection={bulkSelection}
          onSettled={() => void reload().catch(logApiError)}
          onStale={() => void reload().catch(logApiError)}
        />
      ) : null}
    </div>
  );
}

/**
 * One number from the top of the file, said plainly.
 *
 * Three of these sit above the fold and answer the three questions this page is
 * opened with — what is owed, how much property, how many filings — so that the
 * commonest visit needs no section opened at all.
 *
 * `tone` colours only the value, never the tile: a red card for an overdue
 * balance turns the whole page into an alert, and the next person to open a file
 * with a routine unpaid fee reads it as an emergency.
 */
function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'plain',
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'plain' | 'bad';
  className?: string;
}) {
  return (
    <div className={cn('px-4 py-3', className)}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 text-base font-semibold tracking-tight',
          /*
            Only a debt gets a colour. «لا مستحقات» used to be emerald, which
            made the calmest fact on the file the loudest thing on the screen —
            and a page where nothing-owed shouts has no louder register left for
            the file where something is. Nothing due now reads as ordinary text,
            which is what it is.
          */
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A titled card in the rail. The same chrome `CollapsibleSection` wears, minus
 *  the fold — these are the facts the page is read for, so they do not fold. */
function InfoCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      {/*
        The heading is a caption, not a title. It names the card for someone
        scanning the rail and then gets out of the way of the facts, which are
        what the rail is read for — so it is muted and small rather than another
        line of body-weight text competing with the values under it.
      */}
      <h2 className="flex items-center gap-2 border-b px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {title}
      </h2>
      <div className="px-4 py-1">{children}</div>
    </section>
  );
}

/**
 * One fact per line, label and value sharing it — the rail, the «المالك»
 * section of a property card, and the kept household file all use it.
 *
 * Caption-over-value, with an icon each, was the old shape: it turned five
 * facts into ten lines and the card stopped reading as a record and started
 * reading as a form. So: caption at the inline start, value at the inline end,
 * a hairline between. No icons — a person glyph repeated beside
 * الاسم, اسم الأم and الجنس distinguishes nothing, and three of them in a column
 * is just texture. The card's own heading carries the only icon that says
 * anything.
 */
function FactRow({ label, value, ltr, hint }: FactItem) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-end text-sm font-medium">
        {/*
          `dir` belongs on an inline `<bdi>`, never on the block `<dd>`: a
          block carrying dir="ltr" also flips its text-align, so a document
          number jumped to the opposite edge from the Arabic values around it.
          `<bdi>` keeps the digits left-to-right without moving the line.
        */}
        {ltr ? <bdi dir="ltr">{value}</bdi> : value}
        {hint ? (
          <span className="mt-0.5 block text-xs font-normal leading-snug text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/** `FactSection` without the heading — the card above it already carries one. */
function FactList({ facts }: { facts: FactItem[] }) {
  const shown = present(facts);
  if (shown.length === 0) return null;
  return (
    <dl>
      {shown.map((fact) => (
        <FactRow key={fact.label} {...fact} />
      ))}
    </dl>
  );
}

/**
 * «مالك لدى مستأجرين» — the tenancies confirmed as naming this citizen.
 *
 * The owner's half of every link, on the file of the person it bills. Before
 * this a confirmed link could only be seen, or undone, from the tenant's page,
 * so an owner at the counter asking «ليش هالعقار على اسمي؟» had nothing on their
 * own file to point at.
 */
function LandlordOfSection({
  cards,
  base,
  tenant,
  token,
  canEdit,
  onChanged,
  locale,
}: {
  cards: CitizenProfileLandlordOf[];
  base: string;
  tenant: string;
  token: string | null;
  canEdit: boolean;
  onChanged: () => void;
  locale: string;
}) {
  const en = locale === 'en';
  const [unlinking, setUnlinking] = useState<string | null>(null);
  // Standing tenancies first; one that ended stays listed as who rented from them.
  const ordered = [...cards.filter((card) => !card.endedAt), ...cards.filter((card) => card.endedAt)];
  const current = cards.filter((card) => !card.endedAt).length;
  const past = cards.length - current;

  return (
    <CollapsibleSection
      id="landlord-of"
      /*
        «مالك لدى مستأجرين» said what the row was filed as, not what the section
        is for. This lists the people renting from this citizen — the owner's
        half of every confirmed link — so it is named after them. Both capacities
        appear here, a مستأجر with a lease and a شاغل بتسامح without one, and the
        badge on each card tells them apart.
      */
      title={en ? "Tenants in this owner's properties" : 'المستأجرون في عقارات هذا المالك'}
      icon={UserCheck}
      defaultOpen={false}
      summary={
        <span className="text-muted-foreground">
          {current} {en ? 'current' : 'قائم'}
          {past > 0 ? (en ? ` · ${past} ended` : ` · ${past} منتهٍ`) : null}
        </span>
      }
    >
      {/*
        Boxes and rows, the same shape a منشأة card wears above. One tenancy is
        one thing with a handful of labelled facts about it, which is what that
        card already is — two layouts for the same kind of content would be two
        things to keep in step and two things for a reader to learn.
      */}
      <CardGrid
        locale={locale}
        items={ordered.map((card) => {
          const rows: Array<{ label: string; value: React.ReactNode }> = [
            {
              label: en ? 'Capacity' : 'صفة الإشغال',
              value:
                card.occupancyType === 'FREE_OCCUPANT'
                  ? en
                    ? 'Free occupant'
                    : 'شاغل بتسامح'
                  : en
                    ? 'Tenant'
                    : 'مستأجر',
            },
            {
              label: en ? 'Reference' : 'الرقم المرجعي',
              value: card.tenant.referenceNumber ? (
                <bdi dir="ltr" className="font-mono">
                  {card.tenant.referenceNumber}
                </bdi>
              ) : null,
            },
            {
              label: en ? 'Building' : 'اسم المبنى',
              // «—» rather than an empty cell, which is the convention the rest
              // of the admin uses for «nobody wrote one» — see the same row on
              // the property card below.
              value: card.buildingName ?? <span className="text-muted-foreground">—</span>,
            },
            { label: en ? 'Parcel' : 'رقم العقار', value: card.propertyNumber },
            {
              label: en ? 'Units' : 'الوحدات',
              value:
                card.unitCodes.length > 0 ? (
                  <bdi dir="ltr" className="font-mono">
                    {card.unitCodes.join('، ')}
                  </bdi>
                ) : null,
            },
            {
              label: en ? 'Linked on' : 'تاريخ الربط',
              value: card.linkedAt ? formatDate(card.linkedAt) : null,
            },
            {
              label: en ? 'Ended on' : 'انتهى في',
              value: card.endedAt ? formatDate(card.endedAt) : null,
            },
          ].filter((row) => row.value != null && row.value !== '');

          return (
            <div
              key={card.propertyEntryId}
              className={cn(
                'flex h-full flex-col overflow-hidden rounded-lg border',
                card.endedAt ? 'border-dashed bg-background' : 'bg-card',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-4">
                <Link
                  href={`${base}/citizens/${card.tenant.id}`}
                  className="min-w-0 break-words font-semibold text-primary underline-offset-4 hover:underline"
                >
                  {card.tenant.name}
                </Link>
                {card.endedAt ? (
                  <Badge variant="soft-muted">{en ? 'Ended' : 'منتهٍ'}</Badge>
                ) : null}
              </div>

              <dl className="px-4 text-sm">
                {rows.map((row) => (
                  <div key={row.label} className={UNIT_ROW}>
                    <dt className="text-muted-foreground">{row.label}:</dt>
                    <dd className="min-w-0 break-words text-end font-medium">{row.value}</dd>
                  </div>
                ))}
              </dl>

              {canEdit && token && !card.endedAt ? (
                <div className="mt-auto p-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 w-full"
                    onClick={() => setUnlinking(card.propertyEntryId)}
                  >
                    <Unlink className="size-4" aria-hidden />
                    {en ? 'Undo link' : 'إلغاء الربط'}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      />

      {canEdit && token && unlinking ? (
        <LandlordUnlinkDialog
          tenant={tenant}
          token={token}
          propertyEntryId={unlinking}
          open={Boolean(unlinking)}
          onOpenChange={(open) => (open ? undefined : setUnlinking(null))}
          onUnlinked={() => {
            setUnlinking(null);
            onChanged();
          }}
          locale={locale}
        />
      ) : null}
    </CollapsibleSection>
  );
}

/**
 * The bills' columns, one definition for the header and every row, so they
 * cannot drift apart: item · status · due · frequency · amount · actions.
 *
 * From `lg` up the list is one grid and every row is a subgrid of it, so a
 * column is as wide as its widest cell on any row — the actions column fits
 * «تسجيل دفعة نقدية» beside «الوصل» instead of spilling over the amount, as a
 * fixed 13rem did — and the header still lines up. Below `lg` a row stacks
 * into two — item, amount — with the details and the buttons under the item.
 */
const FEE_LIST_GRID = 'lg:grid lg:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto_auto]';
const FEE_ROW_GRID = 'grid-cols-[minmax(0,1fr)_auto] lg:col-span-full lg:grid-cols-subgrid';

/** Bills shown at a time on a citizen's file — a household's years of them would otherwise run the page out. */
const FEES_PAGE_SIZE = 10;

/**
 * The open bill page, in the URL as `?feesPage=` (1-based) so a reload — or
 * coming back from settling a bill on its own page — lands on the same bills.
 * Its own key: `page` would collide with whatever list linked here.
 */
const FEES_URL = { feesPage: param.page() };

/**
 * The citizen's ledger — totals, then every invoice, each settleable on its own.
 *
 * "Clear them one by one" is the point of the list below. A citizen three
 * periods behind owes three separate debts, and a clerk taking cash for one of
 * them must not be forced to settle all three or none: every row carries its
 * own «تسجيل دفعة» and its own receipt. Bulk-only settlement is exactly what
 * made arrears impossible to work down gradually.
 *
 * So «تسديد الفواتير المحددة» is added beside those, never in their place: for
 * the finance roles a box on each settleable bill, and «تحديد الكل» over the
 * page, tick the bills the citizen is paying today; the bar and the dialog that
 * settle them live at the page's root (`selection`). A bill left unticked stays
 * owed, and settleable on its own as before.
 */
function FeesPanel({
  citizen,
  payments,
  fees,
  canManage,
  selection,
  municipalityName,
  governorate,
  councilDecisionRef,
  district,
  contactPhone,
  officeWhatsapp,
  locale = 'ar',
}: {
  citizen: CitizenProfile;
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
  canManage: boolean;
  /** The bills ticked for «تسديد الفواتير المحددة», or null for a role that may not settle several at once. */
  selection: BulkSelection | null;
  municipalityName: string;
  governorate?: string | null;
  councilDecisionRef?: string | null;
  district?: string | null;
  contactPhone?: string | null;
  officeWhatsapp?: string | null;
  locale?: string;
}) {
  const { tenant, adminPath } = useParams<{ tenant: string; adminPath: string }>();
  const tSelect = useTranslations('bulkSettle.select');
  /** «تسجيل دفعة نقدية» is its own page now — ليرة, dollars, the rate — see payments/[paymentId]. */
  const settleHref = (paymentId: string) =>
    `/${tenant}/${locale}/${adminPath}/citizens/${encodeURIComponent(citizen.id)}/payments/${encodeURIComponent(paymentId)}`;
  const [receipt, setReceipt] = useState<{
    payment: CitizenProfilePayment;
    received: number;
  } | null>(null);

  const labels = getLabels(locale);
  const outstanding = payments.filter((payment) => payment.paymentStatus !== 'PAID');
  const [{ feesPage: page }, setFeesUrl] = useUrlState(FEES_URL);
  const setPage = useCallback((next: number) => setFeesUrl({ feesPage: next }), [setFeesUrl]);
  const listTop = useRef<HTMLUListElement>(null);
  // Back inside the list when a reload (or a stale link) leaves fewer pages than the one open.
  const lastPage = Math.max(0, Math.ceil(payments.length / FEES_PAGE_SIZE) - 1);
  const shownPage = Math.min(page, lastPage);
  const pagePayments = payments.slice(shownPage * FEES_PAGE_SIZE, (shownPage + 1) * FEES_PAGE_SIZE);
  /** This page's bills that may be ticked, and where «تحديد الكل» stands over them. */
  const pageEligible = pagePayments.filter(isBulkSettleable).map((row) => fromCitizenPayment(citizen, row));
  const pageState = selection ? pageSelection(selection.bills, pageEligible) : null;

  return (
    <>
      <CollapsibleSection
        id="fees"
        /*
          Open on arrival. With «العقارات» moved to its own page, the bills are
          what this file is opened for at the counter — «شو عليّي؟» — and a
          fold in front of them was one tap between the question and the answer.
        */
        defaultOpen
        title={locale === 'en' ? 'Fees & Ledger' : 'الرسوم والمدفوعات'}
        icon={Wallet}
        summary={
          fees.outstandingTotal > 0 ? (
            <span
              className={cn(
                'font-semibold',
                fees.overdueTotal > 0 ? 'text-destructive' : undefined,
              )}
            >
              <Money amount={fees.outstandingTotal} /> {locale === 'en' ? 'due' : 'مستحق'}
            </span>
          ) : (
            <span className="text-success">
              {locale === 'en' ? 'No balance due' : 'لا مستحقات'}
            </span>
          )
        }
      >
        <div className="space-y-6">
          <StatStrip>
            <StatItem value={<Money amount={fees.feesTotal} />} label={locale === 'en' ? 'Total billed' : 'إجمالي الرسوم'} />
            <StatItem
              value={<Money amount={fees.paidTotal} />}
              label={locale === 'en' ? 'Paid' : 'المسدَّد'}
              className={fees.paidTotal > 0 ? 'text-success' : undefined}
            />
            <StatItem value={<Money amount={fees.outstandingTotal} />} label={locale === 'en' ? 'Unpaid' : 'غير المسدَّد'} />
            <StatItem
              value={<Money amount={fees.overdueTotal} />}
              label={
                locale === 'en'
                  ? `Overdue${fees.overdueCount > 0 ? ` (${fees.overdueCount})` : ''}`
                  : `المتأخرات${fees.overdueCount > 0 ? ` (${fees.overdueCount})` : ''}`
              }
              className={fees.overdueTotal > 0 ? 'text-destructive' : undefined}
            />
          </StatStrip>

          {fees.pendingReviewCount > 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
              <Clock3 className="size-4 shrink-0 text-info" aria-hidden />
              {locale === 'en'
                ? `${fees.pendingReviewCount} payment(s) awaiting verification — review them in Fees & Billing.`
                : `${fees.pendingReviewCount} دفعة بانتظار تحقق الموظف — راجعها من صفحة إدارة الرسوم.`}
            </p>
          ) : null}

          {payments.length === 0 ? (
            <EmptyState
              compact
              icon={Wallet}
              title={locale === 'en' ? 'No fees billed yet' : 'لا رسوم بعد'}
              description={
                locale === 'en'
                  ? 'Bills appear here once a fee is issued to this citizen.'
                  : 'تظهر الفواتير هنا عند إصدار رسم على هذا المواطن.'
              }
            />
          ) : (
            <div className="space-y-2">
            {selection && pageState && pageState.eligible > 0 ? (
              <div className="flex items-center gap-2">
                <BillCheckbox
                  id="citizen-fees-select-page"
                  subject={{ kind: 'page', allSelected: pageState.allSelected }}
                  checked={pageState.allSelected}
                  blocked={pageState.blocked}
                  onToggle={() => selection.toggleRows(pageEligible)}
                />
                <label htmlFor="citizen-fees-select-page" className="text-sm">
                  {pageState.allSelected ? tSelect('pageClear') : tSelect('page')}
                </label>
              </div>
            ) : null}
            <ul ref={listTop} className={cn('divide-y rounded-lg border lg:gap-x-3', FEE_LIST_GRID)}>
              <li
                aria-hidden
                className={cn(
                  'hidden items-center gap-x-3 rounded-t-lg bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid',
                  FEE_ROW_GRID,
                )}
              >
                {/* Past the rows' boxes when they have them (`size-6` and `gap-3`), so the heading sits over the titles. */}
                <span className={selection ? 'ps-9' : undefined}>{locale === 'en' ? 'Item' : 'البند'}</span>
                <span>{locale === 'en' ? 'Status' : 'الحالة'}</span>
                <span>{locale === 'en' ? 'Due' : 'الاستحقاق'}</span>
                <span>{locale === 'en' ? 'Frequency' : 'الدورية'}</span>
                <span className="text-end">{locale === 'en' ? 'Amount' : 'المبلغ'}</span>
                <span />
              </li>
              {pagePayments.map((payment) => {
                const settled = payment.paymentStatus === 'PAID';
                const partly = !settled && payment.paidAmount > 0;
                const breakdown = describeAssessment(payment.assessment, locale);
                return (
                  /*
                    One bill as one row of columns — what it is, its status,
                    when it was due, how often, what it costs, what can be
                    done — each in the same column on every row, under the
                    header above, so the list reads like the ledger it is.

                    From \`lg\` up the details wrapper is \`display: contents\`,
                    so its three items take the grid's own columns. Below it the
                    row stacks: the title with the amount opposite, and the
                    details and buttons under the title.
                  */
                  <li
                    key={payment.id}
                    className={cn('grid items-center gap-x-3 gap-y-2 p-4', FEE_ROW_GRID)}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                    {/*
                      The box for «تسديد الفواتير المحددة», beside the row's own
                      buttons rather than instead of them. A bill that cannot be
                      ticked keeps the box's width, so every title lines up.
                    */}
                    {selection ? (
                      isBulkSettleable(payment) ? (
                        <BillCheckbox
                          subject={{ kind: 'row', title: payment.title }}
                          checked={selection.bills.some((entry) => entry.id === payment.id)}
                          blocked={rowBlock(selection.bills, fromCitizenPayment(citizen, payment))}
                          onToggle={() => selection.toggle(fromCitizenPayment(citizen, payment))}
                        />
                      ) : (
                        <span aria-hidden className="size-6 shrink-0" />
                      )
                    ) : null}
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate font-semibold">{payment.title}</p>
                      {/*
                        «ليش عليّ هالمبلغ؟» — the breakdown stored on the
                        payment since per-unit billing, answered where the
                        collector is asked it.
                      */}
                      {breakdown ? (
                        <p className="truncate text-xs text-muted-foreground">
                          <bdi>{breakdown}</bdi>
                        </p>
                      ) : null}
                      {payment.reviewNote ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {locale === 'en' ? 'Staff note: ' : 'ملاحظة الموظف: '}
                          {payment.reviewNote}
                        </p>
                      ) : null}
                    </div>
                    </div>

                    <div className="col-span-2 col-start-1 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:contents">
                      <span className="lg:text-sm lg:text-foreground">
                        {labels.paymentStatus?.[payment.paymentStatus as never] ?? payment.paymentStatus}
                        {partly ? (locale === 'en' ? ' · partly paid' : ' · جزئياً') : null}
                      </span>
                      <span className="inline-flex items-center gap-1 tabular-nums lg:text-sm lg:text-foreground">
                        <Calendar className="size-3.5 shrink-0 text-muted-foreground lg:hidden" aria-hidden />
                        <span className="lg:hidden">{locale === 'en' ? 'Due ' : 'استحقاق '}</span>
                        {formatDate(payment.dueDate)}
                        {payment.paidAt ? (
                          <span className="ms-1 text-xs text-success">
                            ({locale === 'en' ? 'paid ' : 'سُدّد '}
                            {formatDate(payment.paidAt)})
                          </span>
                        ) : null}
                      </span>
                      <span className="lg:text-sm lg:text-foreground">
                        {payment.frequency
                          ? (labels.feeFrequency?.[payment.frequency as never] ?? payment.frequency)
                          : null}
                      </span>
                    </div>

                    <div className="col-start-2 row-start-1 text-end lg:col-start-auto lg:row-start-auto">
                      <Money amount={payment.amount} exact className="text-base font-bold" />
                      {partly ? (
                        <p className="text-xs text-muted-foreground">
                          {locale === 'en' ? 'Remaining ' : 'متبقٍ '}
                          <Money amount={payment.remaining} exact />
                        </p>
                      ) : null}
                    </div>

                    {canManage ? (
                      <div className="col-span-2 col-start-1 row-start-3 flex items-center gap-2 lg:col-span-1 lg:col-start-auto lg:row-start-auto lg:justify-end">
                        {!settled ? (
                          <Link
                            href={settleHref(payment.id)}
                            className={buttonVariants({ size: 'sm', variant: 'outline' })}
                          >
                            <Banknote className="size-4" aria-hidden />
                            {locale === 'en' ? 'Record cash' : 'تسجيل دفعة نقدية'}
                          </Link>
                        ) : null}
                        {payment.paidAmount > 0 ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setReceipt({ payment, received: payment.paidAmount })}
                          >
                            <ReceiptIcon className="size-4" aria-hidden />
                            {locale === 'en' ? 'Receipt' : 'الوصل'}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            </div>
          )}

          <Pager
            page={shownPage}
            pageSize={FEES_PAGE_SIZE}
            total={payments.length}
            onPageChange={setPage}
            locale={locale}
            label={locale === 'en' ? 'Bill pages' : 'صفحات الفواتير'}
            scrollTarget={listTop}
          />

          {outstanding.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              {locale === 'en'
                ? `${outstanding.length} unpaid claims — each can be settled individually, in full or in part.`
                : `${outstanding.length} مطالبة غير مسدّدة — يمكن تسديد كل منها على حدة، كلياً أو جزئياً.`}
            </p>
          ) : null}
        </div>
      </CollapsibleSection>

      <PaymentReceipt
        open={receipt !== null}
        onOpenChange={(next) => {
          if (!next) setReceipt(null);
        }}
        tenant={tenant}
        // The receipt opens here only for the money roles (`canManage`), each of them a working role.
        canSend={canManage}
        citizen={citizen}
        payment={receipt?.payment ?? null}
        receivedAmount={receipt?.received}
        municipalityName={municipalityName}
        governorate={governorate}
        councilDecisionRef={councilDecisionRef}
        district={district}
        contactPhone={contactPhone}
        officeWhatsapp={officeWhatsapp}
      />
    </>
  );
}

/**
 * A labelled block of facts, absent entirely when the citizen has none of them.
 *
 * Rows, like `FactList` beside it: label at the start, value at the far edge,
 * a hairline between. The parent separates one section from the next.
 */
function FactSection({ title, facts }: { title: string; facts: FactItem[] }) {
  const shown = present(facts);
  if (shown.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <dl>
        {shown.map((fact) => (
          <FactRow key={fact.label} {...fact} />
        ))}
      </dl>
    </div>
  );
}

/** Small icon + label heading used inside a property or attachment block. */
function SubHeading({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {children}
    </p>
  );
}

/** Tap-to-call, kept LTR so the number is not mirrored — drawn as `WhatsAppPhoneLink` is, so the two line up. */
function PhoneLink({ phone, locale }: { phone: string; locale: string }) {
  const label = locale === 'en' ? 'Call' : 'اتصال';
  return (
    <a
      href={`tel:${phone}`}
      dir="ltr"
      className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
      title={label}
      aria-label={`${label} ${formatPhone(phone)}`}
    >
      <Phone className="size-3.5 text-primary" aria-hidden />
      <span>{formatPhone(phone)}</span>
    </a>
  );
}

/** Click-to-chat WhatsApp link, kept LTR with emerald accent. */
function WhatsAppPhoneLink({ phone, message }: { phone: string; message?: string }) {
  const href = buildWhatsappHref(phone, message ?? '') ?? `https://wa.me/${phone.replace(/\D/g, '')}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      dir="ltr"
      className="inline-flex items-center gap-1.5 font-medium text-success hover:text-success hover:underline"
      title="فتح في واتساب"
    >
      <MessageCircle className="size-3.5 text-success" aria-hidden />
      <span>{formatPhone(phone)}</span>
    </a>
  );
}
