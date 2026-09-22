'use client';

import { isValidElement, use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Archive,
  Banknote,
  Building2,
  Calendar,
  Clock3,
  DoorOpen,
  Droplet,
  ExternalLink,
  FileDigit,
  FileQuestion,
  FileText,
  Flag,
  Hash,
  Heart,
  History,
  Home,
  IdCard,
  Key,
  Layers,
  Loader2,
  MapPin,
  MessageCircle,
  Pencil,
  Phone,
  Receipt as ReceiptIcon,
  Ruler,
  Signpost,
  StickyNote,
  Tent,
  Trees,
  Unlink,
  User,
  UserCheck,
  Users,
  Wallet,
} from 'lucide-react';
import { getLabels, OWNER_BILLED_WHILE_ABSENT } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenProfile,
  getDocumentViewUrl,
  getMunicipalitySettings,
  getTenantConfig,
  logApiError,
  settlePayment,
} from '@/lib/api-client';
import type {
  CitizenFeeTotals,
  CitizenProfile,
  CitizenProfileLandlordOf,
  CitizenProfilePayment,
  CitizenProfileProperty,
  CitizenProfileUnit,
  MunicipalitySettings,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { useToast } from '@/components/ui/toast';
import { describeAssessment } from '@/lib/fee-assessment';
import { flagFieldLabel } from '@/lib/field-flags';
import { findLocatedProperty, mapHref } from '@/lib/map-link';
import { ActivityTrail } from '@/components/admin/activity-trail';
import { BuildingHoldings } from '@/components/admin/citizen-building-holdings';
import { AUDIT_ENTITY } from '@/lib/audit-labels';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { LandlordUnlinkDialog } from '@/components/admin/landlord-unlink-dialog';
import { EndTenancyDialog } from '@/components/admin/end-tenancy-dialog';
import { CompleteRecordDialog } from '@/components/admin/complete-record-dialog';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { formatPhone } from '@/lib/phone';
import {
  SettlePaymentDialog,
  type SettleValues,
} from '@/components/admin/settle-payment-dialog';
import { cn } from '@/lib/utils';
import { formatDate, formatMonthList } from '@/lib/dates';
import { buildCitizenWelcomeMessage, buildWhatsappHref } from '@/lib/whatsapp';

/** One glyph per property branch, so a card's kind is readable before its text. */
const PROPERTY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  BUILDING: Building2,
  HOUSE: Home,
  LAND: Trees,
  TENT: Tent,
};


/**
 * Why a home nobody lives in is still charged to its owner.
 *
 * The single most-asked question a «مسكن موسمي» produces at the counter, and
 * the answer is not in the status label. A building is presumed occupied until
 * a تصريح بالشغور is filed (هيئة التشريع والاستشارات 725/2003) and the fee is
 * owed on actual occupancy (Law 60/1988, Art. 11) — so until a declaration
 * exists the year is owed, and shortening it is the council's decision, taken
 * on the facts recorded against the unit.
 */
function ownerBilledHint(status: string | null | undefined, locale: string): string | undefined {
  if (!(OWNER_BILLED_WHILE_ABSENT as readonly string[]).includes(status ?? '')) return undefined;
  return locale === 'en'
    ? 'Nobody lives here most of the year, and the occupancy fee stays with the owner unless a vacancy declaration is filed'
    : 'لا يسكنها أحد معظم السنة، ويبقى رسم الإشغال على المالك ما لم يُقدَّم تصريح بالشغور';
}

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
    directly above it. What used to sit here alongside it was a *second* copy
    of عدد الأبناء المتزوجين under a longer label, so a split household showed
    the same figure twice and invited the reading that they were two counts.
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
    {
      icon: Users,
      label: en ? 'Married Children (Independent)' : 'الأبناء المتزوجون المستقلون',
      value: citizen.marriedChildrenCount?.toString(),
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
 * What a «غير مقيم في البلدة» record still holds from when it was a household.
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
  if (citizen.residence !== 'NON_RESIDENT_OWNER') return null;

  const en = locale === 'en';
  const labels = getLabels(locale);

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
          {en
            ? 'This record was filed as a household before it became a non-resident record. These values are kept as history — the form no longer asks for them and nothing updates them, so do not rely on them as current.'
            : 'سُجِّل هذا الملف كملف أسرة قبل أن يصبح ملف «غير مقيم في البلدة». هذه القيم محفوظة كتاريخ — لم تعد تُطلب في النموذج ولا يحدّثها شيء، فلا يُعتمد عليها كبيانات حالية.'}
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
 * Where one section of a card ends and the next begins — the unit's facts,
 * then «المالك», then a vacancy or seasonal finding.
 *
 * Coloured, and heavier than the hairline between rows, so the two kinds of
 * line cannot be confused: a grey rule says «next fact», this one says «next
 * subject». With both grey, «هاتف المالك» read as one more fact about the flat.
 */
const SECTION_RULE = 'border-t-2 border-primary/30';

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

type UnitCardRow = { label: string; value: React.ReactNode; hint?: string };

/**
 * First mention of a label wins, and an empty one never counts as a mention.
 *
 * The unit's facts are listed before the property's, so where both describe the
 * same thing — حالة الوحدة, مساحة الوحدة, الحقوق المشتركة all exist at both
 * levels — the flat's own answer is the one that survives. That is the right
 * way round: the card is about the flat, and the entry's copy is what a filing
 * said about whichever unit it happened to be opened from.
 */
function dedupeRows(rows: UnitCardRow[]): UnitCardRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.value == null || row.value === '' || seen.has(row.label)) return false;
    seen.add(row.label);
    return true;
  });
}

/**
 * One property entry, split into the cards it should be drawn as — one per منشأة.
 *
 * A مبنى with two flats in it is two cards, not one card holding a list: two
 * flats are two things an officer surveys, bills and disputes separately, and
 * the register's own unit of account is the unit, not the filing that happened
 * to cover both.
 *
 * Flats still held come first and a flat given up follows, the order the units
 * list used. An entry with no units at all — a plot of أرض, a منزل recorded
 * without a breakdown — yields a single card about the entry itself, because
 * there the entry *is* the منشأة.
 *
 * `siblings` is what the rest of the entry's units number, which the card needs
 * in order to warn that «إنهاء الإيجار» ends all of them at once.
 */
function unitCards(
  property: CitizenProfileProperty,
): Array<{ unit: CitizenProfileUnit | null; siblings: number }> {
  const ordered = [
    ...property.units.filter((unit) => !unit.endedAt),
    ...property.units.filter((unit) => unit.endedAt),
  ];
  if (ordered.length === 0) return [{ unit: null, siblings: 0 }];
  return ordered.map((unit) => ({ unit, siblings: ordered.length - 1 }));
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

  const [citizen, setCitizen] = useState<CitizenProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | undefined>();
  const [openingDocId, setOpeningDocId] = useState<string | null>(null);
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
        <Alert tone="error">
          {error}
        </Alert>
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
  const isNonResident = citizen.residence === 'NON_RESIDENT_OWNER';

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
  const hasUnverifiedFields = citizen.registrations.some(
    (registration) => registration.flags.length > 0,
  );

  const locatedProperty = findLocatedProperty(
    citizen.registrations.flatMap((registration) =>
      registration.properties.filter((property) => !property.endedAt),
    ),
  );

  const openDocument = async (documentId: string) => {
    if (!token) return;
    setOpeningDocId(documentId);
    try {
      const { url } = await getDocumentViewUrl(tenant, token, documentId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
      toast.error(locale === 'en' ? 'Failed to open file' : 'تعذّر فتح الملف', {
        description:
          caught instanceof ApiRequestError
            ? caught.message
            : (locale === 'en' ? 'Link may have expired.' : 'قد يكون الرابط منتهي الصلاحية.'),
      });
    } finally {
      setOpeningDocId(null);
    }
  };

  const waMessage = buildCitizenWelcomeMessage({
    fullName: citizen.fullName,
    gender: citizen.gender,
    referenceNumber: citizen.referenceNumber,
    municipalityName,
  });
  const waHref = buildWhatsappHref(citizen.whatsapp || citizen.phone, waMessage);


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
        */
        {
          icon: Home,
          label: en ? 'Lives in' : 'مكان الإقامة',
          value: citizen.residencePlace ?? undefined,
        },
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
      value: citizen.phone ? <PhoneLink phone={citizen.phone} /> : null,
    },
    {
      icon: MessageCircle,
      label: en ? 'WhatsApp' : 'واتساب',
      value: citizen.whatsapp ? (
        <WhatsAppPhoneLink phone={citizen.whatsapp} message={waMessage} />
      ) : null,
    },
    // Who holds the keys here, for an owner who is not here.
    ...(isNonResident
      ? [
          {
            icon: User,
            label: en ? 'Local contact' : 'جهة الاتصال المحلية',
            value: citizen.localContactName ?? undefined,
          },
          {
            icon: Phone,
            label: en ? 'Local contact phone' : 'هاتف جهة الاتصال',
            value: citizen.localContactPhone ? (
              <PhoneLink phone={citizen.localContactPhone} />
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
                  {labels.citizenResidence.NON_RESIDENT_OWNER}
                  {citizen.residencePlace ? ` — ${citizen.residencePlace}` : ''}
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
            {canEdit ? (
              <Link href={`${base}/citizens/${citizen.id}/edit`} className={buttonVariants()}>
                <Pencil className="size-4" aria-hidden />
                {locale === 'en' ? 'Edit Details' : 'تعديل البيانات'}
              </Link>
            ) : null}

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
            municipalityName={municipalityName}
            governorate={settings?.governorate}
            councilDecisionRef={settings?.councilDecisionRef}
            district={settings?.district}
            contactPhone={settings?.contactPhone}
            officeWhatsapp={settings?.whatsappNumber}
            locale={locale}
            onSettled={() => void reload()}
          />

          {/*
            «العقارات» folds like everything else on the page now.

            It was the one long section that could not be put away, so a file
            with four properties buried «مالك لدى مستأجرين» and «سجل العمليات»
            under a page of unit tables. Put away by default, because most
            visits to a settled file are not about the unit tables.

            Except when the record is carrying unverified fields: «يتطلب
            مراجعة» and «استكمال البيانات الناقصة» live inside this section,
            and a warning nobody can see is not a warning. Those files arrive
            open, and the count chip wears the warning tone so the fold is
            legible before it is opened.

            The count survives the fold, which is the only thing that makes a
            closed section worth closing.
          */}
          <CollapsibleSection
            id="properties"
            icon={Building2}
            defaultOpen={hasUnverifiedFields}
            title={locale === 'en' ? 'Properties' : 'العقارات'}
            summary={
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  hasUnverifiedFields
                    ? 'bg-warning/10 text-warning'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {propertyCount}
              </span>
            }
          >
            <div className="space-y-3">
            {citizen.registrations.length === 0 ? (
              <EmptyState
                compact
                icon={Home}
                title={
                  locale === 'en'
                    ? 'No registered properties for this citizen.'
                    : 'لا توجد عقارات مسجّلة لهذا المواطن.'
                }
              />
            ) : null}

            {citizen.registrations.map((registration, registrationIndex) => (
              <Card key={registration.id} className="overflow-hidden">
                <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 border-b bg-muted/30 py-3">
                  <CardTitle className="font-mono text-sm font-semibold">
                    {/* Inline `<bdi>` for the same reason as `FactRow` below. */}
                    <bdi dir="ltr">{registration.referenceNumber}</bdi>
                  </CardTitle>
                  <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Calendar className="size-3.5" aria-hidden />
                    {formatDate(registration.submittedAt)}
                  </p>
                </CardHeader>

                <CardContent className="space-y-4 pt-5">
                  {/*
                    What this record does not know about itself, said first.

                    Above the properties rather than tucked under them, because
                    it changes how everything below it should be read: a
                    collector looking at a parcel with no رقم العقار needs to
                    know that was a decision someone recorded, not a rendering
                    fault or a field someone forgot.
                  */}
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

                  {/*
                    By building, each folded shut; then whatever stands on no
                    censused building (a plot, a tent, a card never linked) as
                    tiles, the way the file lays cards out everywhere else.

                    A household with flats in several buildings used to read as
                    one run of cards with nothing to say which building each was
                    in. Opened, a building shows its matrix with this citizen's
                    flats marked, and a tap on one shows its card — see
                    `BuildingHoldings`.
                  */}
                  {(() => {
                    const current = registration.properties.filter((property) => !property.endedAt);
                    const lines = current.flatMap((property) =>
                      unitCards(property).map(({ unit, siblings }) => ({
                        key: unit ? `${property.id}:${unit.id}` : property.id,
                        property,
                        unit,
                        card: (
                          <PropertyCard
                            key={unit ? `${property.id}:${unit.id}` : property.id}
                            property={property}
                            unit={unit}
                            siblingUnits={siblings}
                            base={base}
                            locale={locale}
                            tenant={tenant}
                            token={token}
                            canEdit={canEdit}
                            onChanged={() => void reload()}
                          />
                        ),
                      })),
                    );
                    const buildings = new Map<string, typeof lines>();
                    const loose: typeof lines = [];
                    for (const line of lines) {
                      const id = line.property.buildingId;
                      if (!id) {
                        loose.push(line);
                        continue;
                      }
                      buildings.set(id, [...(buildings.get(id) ?? []), line]);
                    }
                    return (
                      <div className="space-y-3">
                        {[...buildings].map(([buildingId, group]) => {
                          const first = group[0]!.property;
                          return (
                            <BuildingHoldings
                              key={buildingId}
                              tenant={tenant}
                              token={token}
                              base={base}
                              locale={locale}
                              buildingId={buildingId}
                              buildingCode={first.buildingCode}
                              subtitle={first.buildingName ?? first.buildingPostedNumber}
                              holdings={group.map((line) => ({
                                key: line.key,
                                unitId: line.unit?.unitId ?? null,
                                occupancyType: line.property.occupancyType,
                                ended: Boolean(line.unit?.endedAt),
                                card: line.card,
                              }))}
                              renderGrid={(cards) => <CardGrid locale={locale} items={cards} />}
                            />
                          );
                        })}
                        {loose.length > 0 ? (
                          <CardGrid locale={locale} items={loose.map((line) => line.card)} />
                        ) : null}
                      </div>
                    );
                  })()}

                  {registration.properties.every((property) => property.endedAt) ? (
                    <p className="text-sm text-muted-foreground">
                      {locale === 'en'
                        ? 'No current properties in this application.'
                        : 'لا توجد عقارات قائمة في هذا الطلب.'}
                    </p>
                  ) : null}

                  {/*
                    «إيجارات منتهية» — tenancies this person has left.

                    Kept on the file with their lease rather than deleted, and
                    set apart under their own heading rather than mixed in, so
                    nobody counting what this person holds today counts a flat
                    they left.
                  */}
                  {registration.properties.some((property) => property.endedAt) ? (
                    <div className="space-y-3 border-t pt-4">
                      <SubHeading icon={History}>
                        {locale === 'en'
                          ? `Ended tenancies (${registration.properties.filter((property) => property.endedAt).length})`
                          : `إيجارات منتهية (${registration.properties.filter((property) => property.endedAt).length})`}
                      </SubHeading>
                      {/* Same grid as the current ones, so the two lists read alike. */}
                      <CardGrid
                        locale={locale}
                        items={registration.properties
                          .filter((property) => property.endedAt)
                          .flatMap((property) =>
                            unitCards(property).map(({ unit, siblings }) => (
                              <PropertyCard
                                key={unit ? `${property.id}:${unit.id}` : property.id}
                                property={property}
                                unit={unit}
                                siblingUnits={siblings}
                                base={base}
                                locale={locale}
                                tenant={tenant}
                                token={token}
                                canEdit={canEdit}
                                onChanged={() => void reload()}
                              />
                            )),
                          )}
                      />
                    </div>
                  ) : null}

                  <div className="space-y-2 border-t pt-4">
                    <SubHeading icon={FileText}>
                      {locale === 'en'
                        ? `Attachments ${registration.documents.length > 0 ? `(${registration.documents.length})` : ''}`
                        : `المرفقات ${registration.documents.length > 0 ? `(${registration.documents.length})` : ''}`}
                    </SubHeading>
                    {registration.documents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {locale === 'en'
                          ? 'No attachments for this application.'
                          : 'لا توجد مرفقات لهذا الطلب.'}
                      </p>
                    ) : (
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {registration.documents.map((document) => (
                          <li key={document.id}>
                            <button
                              type="button"
                              onClick={() => openDocument(document.id)}
                              disabled={openingDocId === document.id}
                              className="flex w-full items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3 text-start transition-colors hover:bg-muted/60 disabled:opacity-60"
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <FileText
                                  className="size-4 shrink-0 text-muted-foreground"
                                  aria-hidden
                                />
                                <span className="truncate text-sm font-medium">
                                  {labels.documentType?.[document.type as never] ?? document.type}
                                </span>
                              </span>
                              {openingDocId === document.id ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                              ) : (
                                <ExternalLink
                                  className="size-4 shrink-0 text-muted-foreground"
                                  aria-hidden
                                />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
            </div>
          </CollapsibleSection>

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

/** Tone per payment state, matching the fees screen's vocabulary. */
const PAYMENT_TONE: Record<string, string> = {
  PAID: 'border-success/30 bg-success/10 text-success',
  PENDING_REVIEW:
    'border-info/30 bg-info/10 text-info',
  UNPAID:
    'border-warning/30 bg-warning/10 text-warning',
  OVERDUE: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/**
 * The citizen's ledger — totals, then every invoice, each settleable on its own.
 *
 * "Clear them one by one" is the point of the list below. A citizen three
 * periods behind owes three separate debts, and a clerk taking cash for one of
 * them must not be forced to settle all three or none: every row carries its
 * own «تسجيل دفعة» and its own receipt. Bulk-only settlement is exactly what
 * made arrears impossible to work down gradually.
 */
function FeesPanel({
  citizen,
  payments,
  fees,
  canManage,
  municipalityName,
  governorate,
  councilDecisionRef,
  district,
  contactPhone,
  officeWhatsapp,
  locale = 'ar',
  onSettled,
}: {
  citizen: CitizenProfile;
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
  canManage: boolean;
  municipalityName: string;
  governorate?: string | null;
  councilDecisionRef?: string | null;
  district?: string | null;
  contactPhone?: string | null;
  officeWhatsapp?: string | null;
  locale?: string;
  onSettled: () => void;
}) {
  const { tenant } = useParams<{ tenant: string }>();
  const [settling, setSettling] = useState<CitizenProfilePayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    payment: CitizenProfilePayment;
    received: number;
  } | null>(null);

  const labels = getLabels(locale);
  const outstanding = payments.filter((payment) => payment.paymentStatus !== 'PAID');

  const submit = async ({ amount, note }: SettleValues) => {
    const target = settling;
    if (!target) return;
    const token = loadSession(tenant)?.accessToken;
    if (!token) return;

    setBusy(true);
    setSettleError(null);
    try {
      await settlePayment(tenant, token, target.id, { method: 'CASH', amount, note });
      setSettling(null);
      setReceipt({
        payment: { ...target, remaining: Math.max(target.remaining - amount, 0) },
        received: amount,
      });
      onSettled();
    } catch (caught) {
      logApiError(caught);
      setSettleError(
        caught instanceof ApiRequestError
          ? caught.message
          : (locale === 'en' ? 'Failed to record payment.' : 'تعذّر تسجيل الدفعة.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <CollapsibleSection
        id="fees"
        /*
          Folded on arrival, like «العقارات» and «سجل الموظفين» beside it, so
          the file opens as three headings rather than three walls.

          Nothing is lost by it: the headline tile above already answers the
          amount — «شو عليّي؟» at the counter — and the fold itself carries
          «لا مستحقات» or what is owed. This is the working out, one tap away.
        */
        defaultOpen={false}
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
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Total label={locale === 'en' ? 'Total Billed' : 'إجمالي الرسوم'} value={fees.feesTotal} />
            <Total label={locale === 'en' ? 'Paid' : 'المسدَّد'} value={fees.paidTotal} tone="text-success" />
            <Total label={locale === 'en' ? 'Unpaid Balance' : 'غير المسدَّد'} value={fees.outstandingTotal} />
            <Total
              label={
                locale === 'en'
                  ? `Overdue${fees.overdueCount > 0 ? ` (${fees.overdueCount})` : ''}`
                  : `المتأخرات${fees.overdueCount > 0 ? ` (${fees.overdueCount})` : ''}`
              }
              value={fees.overdueTotal}
              tone={fees.overdueTotal > 0 ? 'text-destructive' : undefined}
            />
          </dl>

          {fees.pendingReviewCount > 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
              <Clock3 className="size-4 shrink-0 text-info" aria-hidden />
              {locale === 'en'
                ? `${fees.pendingReviewCount} payment(s) awaiting verification — review them in Fees & Billing.`
                : `${fees.pendingReviewCount} دفعة بانتظار تحقق الموظف — راجعها من صفحة إدارة الرسوم.`}
            </p>
          ) : null}

          {payments.length === 0 ? (
            <p className="rounded-lg border p-6 text-center text-muted-foreground">
              {locale === 'en' ? 'No fees billed to this citizen yet.' : 'لم تُصدَر أي رسوم على هذا المواطن.'}
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {payments.map((payment) => {
                const settled = payment.paymentStatus === 'PAID';
                const partly = !settled && payment.paidAmount > 0;
                const breakdown = describeAssessment(payment.assessment, locale);
                return (
                  <li key={payment.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 space-y-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          <span className="truncate">{payment.title}</span>
                          <Badge
                            variant="outline"
                            className={cn('shrink-0', PAYMENT_TONE[payment.paymentStatus])}
                          >
                            {labels.paymentStatus?.[payment.paymentStatus as never] ??
                              payment.paymentStatus}
                          </Badge>
                          {partly ? (
                            <Badge variant="outline" className="shrink-0">
                              {locale === 'en' ? 'Partly Paid' : 'مسدَّد جزئياً'}
                            </Badge>
                          ) : null}
                        </p>
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <Calendar className="size-3.5 shrink-0" aria-hidden />
                            {locale === 'en' ? 'Due ' : 'استحقاق '}
                            {formatDate(payment.dueDate)}
                          </span>
                          {payment.frequency ? (
                            <span>
                              {labels.feeFrequency?.[payment.frequency as never] ??
                                payment.frequency}
                            </span>
                          ) : null}
                          {payment.paidAt ? (
                            <span className="text-success">
                              {locale === 'en' ? 'Paid ' : 'سُدّد '}
                              {formatDate(payment.paidAt)}
                            </span>
                          ) : null}
                        </p>
                        {/*
                          «ليش عليّ هالمبلغ؟» — answered on the page where it is
                          asked.

                          The breakdown has been stored on the payment since
                          per-unit billing existed and the fees ledger has shown
                          it; this page, the one a collector opens with the
                          citizen standing in front of them, showed the total
                          alone. «6 محل تجاري × 100,000» is a number they can
                          check against the property cards below it — which is
                          exactly where a wrong one gets corrected.
                        */}
                        {breakdown ? (
                          <p className="text-xs text-muted-foreground">
                            <bdi>{breakdown}</bdi>
                          </p>
                        ) : null}
                        {payment.reviewNote ? (
                          <p className="text-xs text-muted-foreground">
                            {locale === 'en' ? 'Staff note: ' : 'ملاحظة الموظف: '}
                            {payment.reviewNote}
                          </p>
                        ) : null}
                      </div>

                      <div className="shrink-0 text-end">
                        <Money amount={payment.amount} exact className="font-semibold" />
                        {partly ? (
                          <p className="text-xs text-muted-foreground">
                            {locale === 'en' ? 'Remaining ' : 'متبقٍ '}
                            <Money amount={payment.remaining} exact />
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {canManage ? (
                      <div className="flex flex-wrap gap-2">
                        {!settled ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSettleError(null);
                              setSettling(payment);
                            }}
                          >
                            <Banknote className="size-4" aria-hidden />
                            {locale === 'en' ? 'Record Cash Payment' : 'تسجيل دفعة نقدية'}
                          </Button>
                        ) : null}
                        {payment.paidAmount > 0 ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setReceipt({ payment, received: payment.paidAmount })
                            }
                          >
                            <ReceiptIcon className="size-4" aria-hidden />
                            {locale === 'en' ? 'Receipt / WhatsApp' : 'إنشاء وصل وإرسال عبر واتساب'}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {outstanding.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              {locale === 'en'
                ? `${outstanding.length} unpaid claims — each can be settled individually, in full or in part.`
                : `${outstanding.length} مطالبة غير مسدّدة — يمكن تسديد كل منها على حدة، كلياً أو جزئياً.`}
            </p>
          ) : null}
        </div>
      </CollapsibleSection>

      <SettlePaymentDialog
        open={settling !== null}
        onOpenChange={(next) => {
          if (!next) setSettling(null);
        }}
        payment={settling}
        submitting={busy}
        error={settleError}
        onSubmit={(values) => void submit(values)}
      />

      <PaymentReceipt
        open={receipt !== null}
        onOpenChange={(next) => {
          if (!next) setReceipt(null);
        }}
        tenant={tenant}
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

function Total({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-1 text-xl font-bold', tone)}>
        <Money amount={value} />
      </dd>
    </div>
  );
}

function PropertyCard({
  property,
  unit,
  siblingUnits = 0,
  base,
  locale = 'ar',
  tenant,
  token,
  canEdit,
  onChanged,
}: {
  property: CitizenProfileProperty;
  /**
   * The one منشأة this card is about — a flat, a shop, a مستودع.
   *
   * A card is a *unit*, not a property entry: a مبنى with two flats in it is
   * two cards, because two flats are two things an officer surveys, bills and
   * argues about separately, and folding them into one card meant the second
   * one lived in a list inside a fold inside a tile.
   *
   * `null` where the entry has no units at all — a plot of أرض, or a منزل
   * recorded without a unit breakdown. Then the entry itself is the منشأة and
   * the card is about the property, as it always was.
   */
  unit?: CitizenProfileUnit | null;
  /**
   * How many other units share this card's property entry. Drives the warning
   * on «إنهاء الإيجار», which ends the entry and therefore all of them.
   */
  siblingUnits?: number;
  base: string;
  locale?: string;
  tenant: string;
  token: string | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const Icon = PROPERTY_ICON[property.propertyType] ?? Building2;
  const isTenant = property.occupancyType === 'TENANT';
  /*
    A tenancy this person has left: history, with its lease, billed for nothing.
    Nothing on it can be changed from here — not the link, not the ending — and
    the status it recorded is not shown as the flat's status today.
  */
  const ended = Boolean(property.endedAt);
  const currentUnits = property.units.filter((unit) => !unit.endedAt);
  /*
    A شاغل بتسامح has a landlord block too, and no lease.

    The badge stays tinted for a tenancy alone because that is the occupancy
    with a contract behind it and a document to check; a free occupancy is
    neither more nor less remarkable than ownership at a glance. What the two
    non-owner cases share is that someone else owns the property, and that is
    the section below.
  */
  const isNonOwner = isTenant || property.occupancyType === 'FREE_OCCUPANT';
  const labels = getLabels(locale);
  /** The current owners of the flats on this card, once each, as سجل المباني records them. */
  const recordedOwners = currentUnits
    .flatMap((unit) => unit.owners ?? [])
    .filter(
      (owner, index, all) =>
        all.findIndex((other) => (other.citizenId ?? other.name) === (owner.citizenId ?? owner.name)) === index,
    );
  const linkedIsOwner = recordedOwners.some((owner) => owner.citizenId === property.landlordCitizenId);
  const otherOwners = recordedOwners.filter(
    (owner) => !owner.citizenId || owner.citizenId !== property.landlordCitizenId,
  );

  const details = present([
    {
      icon: Hash,
      label: locale === 'en' ? 'Property Number' : 'رقم العقار',
      value: property.propertyNumber,
      ltr: true,
    },
    {
      icon: MapPin,
      label: locale === 'en' ? 'Neighborhood' : 'الحي',
      value: property.neighborhood,
    },
    {
      icon: Building2,
      label: locale === 'en' ? 'Building Name' : 'اسم المبنى',
      /*
        Always on the card, blank where the building has no name.

        Every other field here disappears when it is null, which is right for a
        fact nobody claimed. A building's name is different: officers read down
        the same row on card after card, and a row that is simply missing from
        this one makes them count rows to be sure they are not misreading
        another field as the name. A «—» says «nobody wrote one» in the place
        they are already looking — the same placeholder the building editor and
        the unit drawer use, and a blank cell is the one thing it must not be:
        an empty value beside a label reads as a field that failed to load.

        An element rather than `''` or `null` because `present` and `dedupeRows`
        both drop those, and the row has to stay.
      */
      value: property.buildingName ?? <span className="text-muted-foreground">—</span>,
    },
    /*
      The censused structure this card is attached to.

      `buildingCode` has been on the profile since P4-T4 and this screen showed
      `buildingName` instead — a free-text string that looks identical whether
      the card is linked to the register or not. An officer looking at a card
      they had just registered into a specific flat had no way to tell it had
      worked, which is exactly the doubt that sends someone to re-enter it.
    */
    {
      icon: Building2,
      label: locale === 'en' ? 'Census Record' : 'سجل المباني',
      value: property.buildingCode,
      ltr: true,
    },
    /*
      What is painted on the wall, beside what the register calls it.

      The two are not interchangeable (D14), and a notice prints both precisely
      because they disagree often enough to matter: a collector standing in the
      street trusts the paint. Showing only `buildingCode` sent whoever was
      about to knock out with the half of the pair that is not written on the
      building.
    */
    {
      icon: Signpost,
      label: locale === 'en' ? 'Posted Number' : 'الرقم المدهون',
      value: property.buildingPostedNumber,
      ltr: true,
    },
    {
      icon: Trees,
      label: locale === 'en' ? 'Land Type' : 'نوع الأرض',
      value: property.landType
        ? (labels.landType[property.landType as never] ?? property.landType)
        : null,
    },
    {
      icon: Home,
      label: locale === 'en' ? 'Unit Type' : 'نوع الوحدة',
      value: property.unitType
        ? (labels.unitType[property.unitType as never] ?? property.unitType)
        : null,
    },
    { icon: Layers, label: locale === 'en' ? 'Floor' : 'الطابق', value: property.floor },
    { icon: MapPin, label: locale === 'en' ? 'Side' : 'الجهة', value: property.side },
    {
      icon: Ruler,
      label: locale === 'en' ? 'Area' : 'المساحة',
      value: property.unitArea != null ? `${property.unitArea} ${locale === 'en' ? 'm²' : 'م²'}` : null,
    },
    /*
      أسهم — a share of *ownership*, so only an owner's card has any.

      Gated on the occupancy rather than on the value alone because the value is
      what a legacy row can be wrong about: `branchFieldsOnly` now strips shares
      from a tenant's or free occupant's card, but rows filed before it did are
      still stored with a number on them, and rendering «١٢٠٠/٢٤٠٠» under a
      مستأجر says the register believes they own half the plot.
    */
    {
      icon: Ruler,
      label: locale === 'en' ? 'Shares' : 'الأسهم',
      value:
        property.occupancyType === 'OWNER' && property.shares != null
          ? `${property.shares}/2400`
          : null,
    },
    {
      icon: Tent,
      label: locale === 'en' ? 'Tent Location' : 'موقع الخيمة',
      value: property.tentLocation,
    },
    {
      icon: Key,
      label: locale === 'en' ? 'Shared Rights' : 'الحقوق المشتركة',
      value: property.sharedRights.length > 0 ? property.sharedRights.join(', ') : null,
    },
    {
      icon: DoorOpen,
      label: locale === 'en' ? 'Unit Status' : 'حالة الوحدة',
      // `present` drops a null row, so an unrecorded status shows as an absent
      // fact rather than as a rendered «—» claiming something was established.
      value:
        property.unitStatus && !ended
          ? (labels.unitStatus[property.unitStatus as never] ?? property.unitStatus)
          : null,
      hint: ended ? undefined : ownerBilledHint(property.unitStatus, locale),
    },
  ]);

  const landlord = present([
    {
      icon: User,
      label: locale === 'en' ? 'Landlord Name' : 'اسم المالك',
      /*
        A confirmed owner is a *person in the register*, not a string.

        `landlordCitizenId` is set only by «نعم، هذا هو المالك» — a decision
        somebody made, on the landlord-links queue, and then had no way to see
        again: this card printed the typed name either way. Linking it means the
        answer to «من هو المالك؟» is one click rather than a second search on a
        name that may be spelled differently on the other record.
      */
      value:
        /*
          Both halves required, not just the id. A confirmed link survives the
          name being flagged «غير مؤكَّد» afterwards, which blanks the name —
          and a link with no text inside it is an invisible target that `present`
          would keep, because a React element is never null.
        */
        property.landlordCitizenId && property.landlordName ? (
          <Link
            href={`${base}/citizens/${property.landlordCitizenId}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {property.landlordName}
          </Link>
        ) : (
          property.landlordName
        ),
      hint:
        property.landlordCitizenId && property.landlordName
          ? (locale === 'en' ? 'Registered citizen — link confirmed' : 'مواطن مسجَّل — تم تأكيد الربط')
          : undefined,
    },
    /*
      What the tenant actually said, when it is not what the card now shows.

      The name above is the owner's registered one while the link stands. The
      tenant's own words are kept rather than overwritten, and shown here, so
      whoever is checking whether the link was right can see what it was made
      from.
    */
    {
      icon: StickyNote,
      label: locale === 'en' ? 'As the tenant gave it' : 'كما ذكره المستأجر',
      value:
        property.landlordCitizenId &&
        property.landlordNameAsTyped &&
        property.landlordNameAsTyped !== property.landlordName
          ? property.landlordNameAsTyped
          : null,
    },
    {
      icon: Phone,
      label: locale === 'en' ? 'Landlord Phone' : 'هاتف المالك',
      value: property.landlordPhone ? <PhoneLink phone={property.landlordPhone} /> : null,
    },
    /*
      Everyone else سجل المباني records as owning these flats.

      A tenancy names the one owner the tenant deals with; a flat can have
      several (heirs, each with أسهم). They are read from the unit, not stored on
      the card, so nobody is hidden behind the linked name and a change of
      ownership shows here without anyone editing this file. On a card linked to
      nobody they are simply the flat's owners, which is what an officer needs to
      see before linking one.
    */
    {
      icon: Users,
      label: property.landlordCitizenId
        ? locale === 'en'
          ? 'Co-owners of the unit'
          : 'شركاؤه في ملكية الوحدة'
        : locale === 'en'
          ? 'Owners in the building register'
          : 'مالكو الوحدة في سجل المباني',
      value: otherOwners.length > 0 ? (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {otherOwners.map((owner) => (
            <span key={owner.citizenId ?? owner.name}>
              {owner.citizenId ? (
                <Link
                  href={`${base}/citizens/${owner.citizenId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {owner.name}
                </Link>
              ) : (
                owner.name
              )}
              {owner.phone ? (
                <span className="ms-1.5 text-xs font-normal">
                  <PhoneLink phone={owner.phone} />
                </span>
              ) : null}
              {owner.shares ? (
                <span className="ms-1 text-xs font-normal text-muted-foreground">
                  ({owner.shares}/2400)
                </span>
              ) : null}
            </span>
          ))}
        </span>
      ) : null,
      hint:
        property.landlordCitizenId && !linkedIsOwner && recordedOwners.length > 0
          ? locale === 'en'
            ? 'The linked landlord is not recorded as an owner of this unit — check the link or the unit.'
            : 'المالك المربوط غير مسجَّل مالكاً لهذه الوحدة — راجِع الربط أو الوحدة.'
          : !property.landlordCitizenId
            ? locale === 'en'
              ? 'This tenancy is not linked to any of them.'
              : 'هذا الإيجار غير مربوط بأيٍّ منهم.'
            : undefined,
    },
  ]);

  /*
    The three facts that tell one property from another at a glance.

    Not the whole `details` list, which runs to ten rows on a full card: a tile
    that reprints everything is not a tile, it is the old card made narrow. الحي
    and اسم المبنى are how somebody says which property they mean out loud, and
    the unit count is the one number that changes what the card *is* — a منزل
    with no flats and a مبنى with twelve read very differently. Everything else
    is a click away and still on the same screen.
  */
  /*
    Every fact about this منشأة, in one list.

    Three lists — a glance, the property's facts, the unit's — meant three
    paddings, three separator styles and, worse, the same fact twice: الطابق and
    مساحة الوحدة were printed once as a glance row and again as a unit row, a
    hand's width apart. One list, deduplicated by label with the first mention
    winning, cannot do that.

    Order is identity first (what kind of thing, held how), then the منشأة
    itself, then the عقار it sits in — narrowing outward, so the unit's own
    facts are never below the building's.
  */
  const rows = dedupeRows([
    {
      label: locale === 'en' ? 'Property type' : 'نوع العقار',
      value: labels.propertyType[property.propertyType as never] ?? property.propertyType,
    },
    {
      label: locale === 'en' ? 'Occupancy' : 'صفة الإشغال',
      value: labels.occupancyType[property.occupancyType as never] ?? property.occupancyType,
    },
    ...(unit ? unitFactRows(unit, locale, ended || Boolean(unit.endedAt)) : []),
    ...details.map((fact) => ({
      label: fact.label,
      value: fact.ltr ? <bdi dir="ltr">{fact.value}</bdi> : fact.value,
      hint: fact.hint,
    })),
  ]);

  return (
    <div
      className={cn(
        // `h-full` so a tile stretches to its row — see the grid that holds these.
        'flex h-full flex-col overflow-hidden rounded-lg border bg-card',
        // The dashed border and «منتهية» say it ended. A darker fill on top
        // made it read as a hole in the page rather than a card.
        ended && 'border-dashed',
      )}
    >
      {/*
        `items-center`, not `items-start`: the icon square, the unit's name and
        «عرض على الخريطة» are three parts of one line and were sitting on three
        different baselines — the icon is 40px tall, the name is one line of
        text and the link is another, so top-aligning them stepped them down the
        header. Centred, they read as the single row they are.
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              ended ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
            )}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 space-y-1.5">
            {/*
              A card whose رقم العقار was never established says so, rather
              than rendering "العقار رقم " with nothing after it — which reads
              as a bug and tells a collector nothing about why.
            */}
            {/*
              A unit card is named by its unit — «شقة ٠٢٠١» — because that is
              what somebody standing at the door is holding. The عقار it belongs
              to is context, and context is in «التفاصيل». An entry with no
              units at all keeps the old headline: there, the عقار is the thing.
            */}
            <p className="font-semibold">
              {unit ? (
                /*
                  The type alone — «شقة», «مكتب». The number used to follow it
                  here and also appear as «رقم الوحدة» in the rows below, so the
                  card said it twice. The rows are where a reader looks up a
                  value; the headline only has to say what kind of thing this is.
                */
                unit.unitType ? (
                  (labels.unitType[unit.unitType as never] ?? unit.unitType)
                ) : locale === 'en' ? (
                  'Unit'
                ) : (
                  'وحدة'
                )
              ) : property.propertyNumber ? (
                <>
                  {locale === 'en' ? 'Property #' : 'العقار رقم '}
                  <span dir="ltr" className="font-mono">
                    {property.propertyNumber}
                  </span>
                </>
              ) : (
                <span className="text-warning">
                  {locale === 'en' ? 'Property number unverified' : 'رقم العقار غير مؤكَّد'}
                </span>
              )}
            </p>
            {/*
              نوع العقار and صفة الإشغال used to be pills here. They are two of
              the card's facts and they now read as facts, labelled, in the list
              below — «نوع العقار: مبنى» rather than a bare «مبنى» the reader has
              to place. What is left up here is not attributes but alarms: a
              structure recorded as war-damaged, and a card that has ended.
            */}
            <div className="flex flex-wrap items-center gap-1.5">
              {/*
                «متضررة من الحرب وغير مسكونة» — beside the card's own badges,
                because it is a fact about the structure that changes how
                everything on the card reads. The flats are recorded exactly as
                any building's are, deliberately: a damaged block's unit count
                is what a reconstruction programme is costed on. So nothing else
                here distinguishes this card from one in a building full of
                people, and an invoice raised against it would look ordinary.
              */}
              {property.buildingLifecycleStatus === 'WAR_DAMAGED_UNINHABITED' ? (
                <Badge variant="soft-destructive">
                  {labels.buildingLifecycle.WAR_DAMAGED_UNINHABITED}
                </Badge>
              ) : null}
              {ended ? (
                <Badge variant="soft-muted">{locale === 'en' ? 'Ended' : 'منتهية'}</Badge>
              ) : null}
            </div>
            {ended ? (
              <p className="text-xs text-muted-foreground">
                {locale === 'en' ? 'Ended on ' : 'انتهت في '}
                {formatDate(property.endedAt!)}
                {property.endReason
                  ? ` — ${labels.occupancyEndReason[property.endReason as never] ?? property.endReason}`
                  : null}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {property.latitude != null ? (
            <Link
              href={mapHref(base, property)}
              className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <MapPin className="size-3.5" aria-hidden />
              {locale === 'en' ? 'View on Map' : 'عرض على الخريطة'}
            </Link>
          ) : null}
          {/*
            «إنهاء الإيجار» — for when they have left. On the card itself, beside
            its name, because the card is what ends; the dialog asks what the
            flat is now before anything is written.
          */}
          {/*
            The tenancy ends per *entry*, not per unit — `propertyEntryId` is
            what `EndTenancyDialog` writes against. Where one entry covers
            several flats, every one of their cards carries this button and any
            of them ends the lot, so the button says so rather than letting an
            officer discover it from the other cards going grey.
          */}
          {isNonOwner && !ended && canEdit && token ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none"
              onClick={() => setEndOpen(true)}
              title={
                siblingUnits > 0
                  ? locale === 'en'
                    ? `Ends this tenancy for all ${siblingUnits + 1} units on this application`
                    : `يُنهي هذا الإيجار عن وحدات هذا الطلب كلّها (${siblingUnits + 1})`
                  : undefined
              }
            >
              <DoorOpen className="size-4" aria-hidden />
              {isTenant
                ? locale === 'en'
                  ? 'End tenancy'
                  : 'إنهاء الإيجار'
                : locale === 'en'
                  ? 'End occupancy'
                  : 'إنهاء الإشغال'}
              {siblingUnits > 0 ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {locale === 'en' ? `(${siblingUnits + 1} units)` : `(${siblingUnits + 1} وحدات)`}
                </span>
              ) : null}
            </Button>
          ) : null}
        </div>
        {isNonOwner && !ended && canEdit && token ? (
          <EndTenancyDialog
            tenant={tenant}
            token={token}
            propertyEntryId={property.id}
            open={endOpen}
            onOpenChange={setEndOpen}
            onEnded={onChanged}
            locale={locale}
          />
        ) : null}
      </div>

      {/* One list, one padding, values at the inline end. */}
      {rows.length > 0 ? (
        <dl className="px-4 text-sm">
          {rows.map((row) => (
            <div key={row.label} className={UNIT_ROW}>
              <dt className="text-muted-foreground">{row.label}:</dt>
              <dd className="min-w-0 break-words text-end font-medium">
                {row.value}
                {row.hint ? (
                  <span className="mt-0.5 block text-xs font-normal leading-snug text-muted-foreground">
                    {row.hint}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
        «المالك» — its own section under a coloured rule, and its facts in the
        same rows as the flat's above: label at the start, value at the far
        edge. Stacked caption-over-value with an icon each, three facts took
        nine lines and looked like a different kind of card.
      */}
      {isNonOwner && landlord.length > 0 ? (
        <div className={cn(SECTION_RULE, 'px-4 pt-3')}>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
            <SubHeading icon={UserCheck}>{locale === 'en' ? 'Landlord' : 'المالك'}</SubHeading>
            {property.landlordCitizenId && !ended && canEdit && token ? (
              <Button variant="outline" size="sm" className="h-9" onClick={() => setUnlinkOpen(true)}>
                <Unlink className="size-4" aria-hidden />
                {locale === 'en' ? 'Undo link' : 'إلغاء الربط'}
              </Button>
            ) : null}
          </div>
          <dl>
            {landlord.map((fact) => (
              <FactRow key={fact.label} {...fact} />
            ))}
          </dl>
          {property.landlordCitizenId && !ended && canEdit && token ? (
            <LandlordUnlinkDialog
              tenant={tenant}
              token={token}
              propertyEntryId={property.id}
              open={unlinkOpen}
              onOpenChange={setUnlinkOpen}
              onUnlinked={onChanged}
              locale={locale}
            />
          ) : null}
        </div>
      ) : null}

      {/*
        The two findings that are sentences, not values — see `UnitNotes`. The
        rows above already carry everything that fits in a row.
      */}
      {unit ? <UnitNotes unit={unit} locale={locale} ended={ended || Boolean(unit.endedAt)} /> : null}
    </div>
  );
}

/**
 * «الوحدة» — what the citizen filed about one منشأة, and what the census says back.
 *
 * Two sources meet here and they are not the same claim. The card is the
 * owner's own description of the flat; the linked `Unit` is سجل المباني's, and
 * billing reads the census first (`unitStatus ?? ownerDeclaredStatus`). Showing
 * only the card's version was showing the one that loses.
 *
 * Every field here is nullable and every one of them means «لم يُسأل» when it
 * is null — a per-unit «غير مؤكَّد» flag blanks the field it excuses (migration
 * 0031), so a flat an officer could only half describe arrives with no type, no
 * floor and no area. These rendered unconditionally once, which produced
 * «الطابق » followed by nothing and a bare «م²».
 *
 * A block of facts rather than a list row: each unit now has a card of its own
 * (see `PropertyCard`'s `unit`), so this is the body of one, not an item in a
 * list inside somebody else's.
 */
function unitFactRows(
  unit: CitizenProfileUnit,
  locale: string,
  /**
   * The tenancy on this flat is over. Its status, vacancy and seasonal lines
   * describe the flat today — somebody else's business now — so they are not
   * shown under a person who no longer lives there.
   */
  ended = false,
): Array<{ label: string; value: React.ReactNode }> {
  const en = locale === 'en';
  const labels = getLabels(locale);

  /*
    Shown only when the two disagree. Where the census simply repeats the card,
    a second badge saying the same word twice is noise on a row that already
    carries five things.
  */
  const censusDiffers =
    !ended && unit.censusUnitStatus != null && unit.censusUnitStatus !== unit.unitStatus;

  /*
    Every field the flat has, each on its own line behind its own label.

    This row used to be one wrapping line of badges and icon-prefixed values —
    «شقة  #0201  ⛁ الطابق ٢  ⛶ ١٤٠ م²» — which is compact and unreadable: the
    icon was the only thing naming each value, so «٢» and «١٤٠ م²» sat next to
    each other and the reader worked out which was the floor. A flat is read
    here to answer a specific question (what floor? how big? whose?), and a
    labelled line answers it without being decoded.

    `null` drops a row; two fields state their own absence instead, because a
    missing line and an unmeasured flat are different things — see مساحة الوحدة
    and نوع الوحدة below.
  */
  return [
    {
      label: en ? 'Unit type' : 'نوع الوحدة',
      value: unit.unitType ? (
        (labels.unitType[unit.unitType as never] ?? unit.unitType)
      ) : (
        <span className="font-normal text-muted-foreground">
          {en ? 'Unverified' : 'غير مؤكَّد'}
        </span>
      ),
    },
    {
      label: en ? 'Unit number' : 'رقم الوحدة',
      value: unit.unitCode ? (
        <bdi dir="ltr" className="font-mono">
          {unit.unitPostedNumber ?? unit.unitCode}
        </bdi>
      ) : null,
    },
    { label: en ? 'Floor' : 'الطابق', value: unit.floor ?? null },
    {
      /*
        Said rather than left out when nobody has measured the flat. A clerk
        reads this to decide whether a PER_AREA notice can be priced — it
        cannot, against an unmeasured unit (see `assessCitizen`) — and a row
        that simply has no area on it looks like one the page forgot.
      */
      label: en ? 'Unit area' : 'مساحة الوحدة',
      value:
        unit.unitArea != null ? (
          `${unit.unitArea} ${en ? 'm²' : 'م²'}`
        ) : (
          <span className="font-normal text-muted-foreground">
            {en ? 'Not recorded' : 'غير مسجَّلة'}
          </span>
        ),
    },
    { label: en ? 'Side' : 'الجهة', value: unit.side ?? null },
    {
      label: en ? 'Shared rights' : 'الحقوق المشتركة',
      value: unit.sharedRights.length > 0 ? unit.sharedRights.join('، ') : null,
    },
    {
      /*
        Plain text, not a tinted badge. A value that is the only coloured thing
        on an otherwise grey card reads as an alarm, and «مشغولة من المالك» is
        the ordinary case — so the colour was firing on almost every card and
        meaning nothing by the third one.
      */
      label: en ? 'Unit status' : 'حالة الوحدة',
      value:
        unit.unitStatus && !ended
          ? (labels.unitStatus[unit.unitStatus as never] ?? unit.unitStatus)
          : null,
    },
    {
      /*
        Only where the two disagree — see `censusDiffers` — and labelled for
        what it is. «سجل المباني» alone collided with the building's own code
        row of the same name once every row shared one list.
      */
      label: en ? 'Status per census' : 'حالة الوحدة في السجل',
      value: censusDiffers
        ? (labels.unitStatus[unit.censusUnitStatus as never] ?? unit.censusUnitStatus)
        : null,
    },
    {
      label: en ? 'Left on' : 'تركها في',
      value: unit.endedAt ? formatDate(unit.endedAt) : null,
    },
  ].filter((row) => row.value != null && row.value !== '');
}

/**
 * The two findings that are sentences rather than values.
 *
 * «تأكيد الشغور» is the reason nobody is being billed for this flat, and
 * «مسكن موسمي» is why an owner who is away all year is billed all year. Both
 * are stated with what they rest on and when — Shura 518/2007: failing to file
 * a declaration does not make an occupied flat vacant, and a neighbour's word
 * is not the same evidence as a تصريح — so neither reduces to a word in the
 * rows above.
 */
function UnitNotes({
  unit,
  locale,
  ended = false,
}: {
  unit: CitizenProfileUnit;
  locale: string;
  ended?: boolean;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const seasonalMonths = unit.presenceMonths?.length
    ? formatMonthList(unit.presenceMonths, locale)
    : null;
  const showVacancy = Boolean(unit.vacancy) && !ended;
  const showSeasonal =
    !ended && (unit.unitStatus === 'SEASONAL' || unit.censusUnitStatus === 'SEASONAL');
  // Nothing at all rather than an empty section: each one opens with a
  // coloured rule, and a rule over nothing is a line that means nothing.
  if (!showVacancy && !showSeasonal) return null;

  return (
    <div className="text-sm">

      {/*
        «تأكيد الشغور» — the reason nobody is being billed for this flat.

        A finding with a consequence, so it is stated with what it rests on and
        when it was made rather than reduced to the word «شاغرة» in a badge: the
        owner disputing a bill and the resident disputing its absence are both
        entitled to read which of the four bases an officer actually had (Shura
        518/2007 — failing to file a declaration does not make an occupied flat
        vacant, and a neighbour's word is not the same evidence as a تصريح).
      */}
      {showVacancy && unit.vacancy ? (
        <dl className={cn(SECTION_RULE, 'px-4 text-sm')}>
          <div className={UNIT_ROW}>
            <dt className="text-muted-foreground">{en ? 'Confirmed vacant' : 'شغور مؤكَّد'}:</dt>
            <dd className="min-w-0 break-words text-end font-medium">
              {formatDate(unit.vacancy.observedAt)}
            </dd>
          </div>
          <div className={UNIT_ROW}>
            <dt className="text-muted-foreground">{en ? 'Basis' : 'المستند'}:</dt>
            <dd className="min-w-0 break-words text-end font-medium">
              {unit.vacancy.basis
                ? (labels.vacancyBasis[unit.vacancy.basis as never] ?? unit.vacancy.basis)
                : en
                  ? 'Not recorded (backfilled)'
                  : 'دون مستند مسجَّل (سجل مُرحَّل)'}
            </dd>
          </div>
        </dl>
      ) : null}

      {/*
        «مسكن موسمي» — why an owner who is away all year is billed all year.

        The status label says the flat is seasonal; these three say what the
        council's decision to shorten the fee would rest on. Recorded for
        exactly that and read by nothing else, so this page is where they are
        readable at all.
      */}
      {showSeasonal ? (
        <dl className={cn(SECTION_RULE, 'px-4 text-sm')}>
          {seasonalMonths ? (
            <div className={UNIT_ROW}>
              <dt className="text-muted-foreground">{en ? 'Present' : 'أشهر الحضور'}:</dt>
              <dd className="min-w-0 break-words text-end font-medium">{seasonalMonths}</dd>
            </div>
          ) : null}
          {unit.ownerLastStayAt ? (
            <div className={UNIT_ROW}>
              <dt className="text-muted-foreground">{en ? 'Last stay' : 'آخر إقامة'}:</dt>
              <dd className="min-w-0 break-words text-end font-medium">
                {formatDate(unit.ownerLastStayAt)}
              </dd>
            </div>
          ) : null}
          {unit.vacancyDeclaredAt ? (
            <div className={UNIT_ROW}>
              <dt className="text-muted-foreground">{en ? 'Vacancy declared' : 'تصريح بالشغور'}:</dt>
              <dd className="min-w-0 break-words text-end font-medium">
                {formatDate(unit.vacancyDeclaredAt)}
              </dd>
            </div>
          ) : null}
          {!seasonalMonths && !unit.ownerLastStayAt && !unit.vacancyDeclaredAt ? (
            <div className={UNIT_ROW}>
              <dt className="text-muted-foreground">{en ? 'Seasonal record' : 'سجل الموسمية'}:</dt>
              <dd className="min-w-0 break-words text-end font-normal text-muted-foreground">
                {en ? 'Nothing recorded' : 'لم يُسجَّل شيء'}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
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

/** Click-to-call, kept LTR so the number is not mirrored in an RTL page. */
function PhoneLink({ phone }: { phone: string }) {
  return (
    <a href={`tel:${phone}`} dir="ltr" className="font-medium text-primary hover:underline">
      {formatPhone(phone)}
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
