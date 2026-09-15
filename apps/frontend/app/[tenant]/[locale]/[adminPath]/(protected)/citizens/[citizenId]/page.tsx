'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Archive,
  Banknote,
  Building2,
  Calendar,
  Clock3,
  DoorClosed,
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
  Sun,
  Tent,
  Trees,
  Unlink,
  User,
  UserCheck,
  Users,
  Wallet,
} from 'lucide-react';
import {
  getLabels,
  isUnoccupied,
  OWNER_BILLED_WHILE_ABSENT,
} from '@mechanization/shared-schemas';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { LandlordUnlinkDialog } from '@/components/admin/landlord-unlink-dialog';
import { EndTenancyDialog } from '@/components/admin/end-tenancy-dialog';
import { LoadingState } from '@/components/ui/states';
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
 * Three tones, because حالة الوحدة answers three different money questions.
 *
 * `warning` for the statuses that stop the occupancy fee — شاغرة, قيد الإنجاز.
 * That is the only group `isUnoccupied` names, and it was the whole vocabulary
 * this page had.
 *
 * `soft-info` for «مسكن موسمي», which is deliberately in neither the unoccupied
 * list nor the occupied-by-others one (`OWNER_BILLED_WHILE_ABSENT`): nobody
 * lives there most of the year *and the owner is still billed*. Drawn as an
 * ordinary outline badge it read as "occupied, nothing to see", which is the
 * one reading that makes the bill look like a mistake.
 */
function unitStatusTone(
  status: string | null | undefined,
): 'warning' | 'soft-info' | 'outline' {
  if ((OWNER_BILLED_WHILE_ABSENT as readonly string[]).includes(status ?? '')) return 'soft-info';
  return isUnoccupied(status) ? 'warning' : 'outline';
}

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
        <div className="grid gap-x-6 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          <FactSection stack title={en ? 'Identity' : 'الهوية'} facts={identity} />
          <FactSection stack title={en ? 'Household' : 'الأسرة'} facts={household} />
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
      <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:px-8">
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
  const isNonResident = citizen.residence === 'NON_RESIDENT_OWNER';

  // What they hold now — a tenancy they left is history, not a property.
  const propertyCount = citizen.registrations.reduce(
    (total, registration) =>
      total + registration.properties.filter((property) => !property.endedAt).length,
    0,
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

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink
        fallbackHref={`${base}/citizens`}
        label={locale === 'en' ? 'Back' : 'رجوع'}
        className="text-sm"
      />

      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-6">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20"
          >
            <User className="size-7" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <h1 className="truncate text-3xl font-bold tracking-tight">{citizen.fullName}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <FileText className="size-3.5" aria-hidden />
                {citizen.registrations.length} {locale === 'en' ? 'applications' : 'طلب'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="size-3.5" aria-hidden />
                {propertyCount} {locale === 'en' ? 'properties' : 'عقار'}
              </span>
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
                <Badge variant="soft-warning">
                  {en ? 'Deactivated record' : 'سجل معطّل'}
                </Badge>
              ) : null}
              {/*
                Household badges, and only on a household file. On a
                non-resident record these are retained values the form no longer
                asks for — they belong under «بيانات محفوظة», labelled, not in
                the headline where they read as this person's current standing.
              */}
              {!isNonResident && citizen.gender ? (
                <Badge variant="outline">{labels.gender[citizen.gender as never] ?? citizen.gender}</Badge>
              ) : null}
              {!isNonResident && citizen.bloodType ? (
                <Badge variant="outline" className="border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400">
                  <Droplet className="me-1 size-3" />
                  {labels.bloodType?.[citizen.bloodType as never] ?? citizen.bloodType}
                </Badge>
              ) : null}
              {!isNonResident && citizen.residentStatus ? (
                <Badge variant="outline">
                  {labels.residentStatus[citizen.residentStatus as never] ?? citizen.residentStatus}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {waHref ? (
            <a
              href={waHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({
                variant: 'outline',
                className:
                  'border-emerald-600/30 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70',
              })}
              title={
                locale === 'en'
                  ? 'Send reference number and registration confirmation via WhatsApp'
                  : 'إرسال الرقم المرجعي وتأكيد التسجيل عبر واتساب'
              }
            >
              <MessageCircle className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span>{locale === 'en' ? 'Send via WhatsApp' : 'إرسال عبر واتساب'}</span>
            </a>
          ) : null}

          {canEdit ? (
            <Link href={`${base}/citizens/${citizen.id}/edit`} className={buttonVariants()}>
              <Pencil className="size-4" aria-hidden />
              {locale === 'en' ? 'Edit Details' : 'تعديل البيانات'}
            </Link>
          ) : null}
          <Link
            href={locatedProperty ? mapHref(base, locatedProperty) : `${base}/map`}
            className={buttonVariants({ variant: 'outline' })}
            title={
              locatedProperty
                ? undefined
                : (locale === 'en'
                    ? 'No property location has been mapped for this citizen yet'
                    : 'لم يتم تحديد موقع أي عقار لهذا المواطن بعد')
            }
          >
            <MapPin className="size-4" aria-hidden />
            {locale === 'en' ? 'View on Map' : 'عرض على الخريطة'}
          </Link>
        </div>
      </div>

      <CollapsibleSection
        id="personal"
        defaultOpen={false}
        title={locale === 'en' ? 'Personal Details' : 'البيانات الشخصية'}
        icon={IdCard}
        className="[&_summary]:pb-4"
        summary={
          /*
            What a closed section still tells you — and it can no longer be the
            document number, which a Lebanese household is no longer asked for
            at all. The most identifying thing the record now holds takes its
            place: اسم الأم on a household, مكان الإقامة on a non-resident.
          */
          <span className="inline-block max-w-[12rem] truncate align-bottom text-muted-foreground">
            {isNonResident
              ? citizen.residencePlace
              : (citizen.motherName ?? citizen.identityDocNumber ?? null)}
          </span>
        }
      >
        <div className="-m-5 divide-y">
          <FactSection
            title={en ? 'Identity' : 'الهوية'}
            facts={
              isNonResident
                ? [
                    {
                      icon: User,
                      label: en ? 'Name' : 'الاسم',
                      value: citizen.fullName,
                    },
                    /*
                      Where they live, in the identity block rather than under
                      «التواصل» — on this kind of record it is not a way to
                      reach them, it is the fact that defines the record. Law
                      60/1988 Art. 14 wants the occupancy notice to name the
                      occupant *and where they live*, and this is that.
                    */
                    {
                      icon: Home,
                      label: en ? 'Lives in' : 'مكان الإقامة',
                      value: citizen.residencePlace ?? undefined,
                    },
                  ]
                : [
                    {
                      icon: User,
                      label: en ? 'Name' : 'الاسم',
                      value: citizen.fullName,
                    },
                    /*
                      Beside the name, because it is part of how this person is
                      named — and because it is the only thing on this card that
                      separates them from a namesake now that no identity
                      document is asked.

                      Rendered as «لم يُسأل» rather than dropped when null,
                      which is what a household filed before migration 0044
                      holds. A row that vanishes is indistinguishable from a
                      field this page forgot; the visible «لم يُسأل» is the
                      difference between "we did not ask" and "she has no name",
                      and it is the prompt to ask next time the door opens.
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
                    {
                      icon: Flag,
                      label: en ? 'Nationality' : 'الجنسية',
                      value: citizen.nationality,
                    },
                    {
                      icon: Home,
                      label: en ? 'Residency Status' : 'صفة الإقامة',
                      value:
                        labels.residentStatus[citizen.residentStatus as never] ??
                        citizen.residentStatus,
                    },
                    {
                      icon: IdCard,
                      label: en ? 'ID Document Type' : 'نوع وثيقة الإثبات',
                      value:
                        labels.identityDocType[citizen.identityDocType as never] ??
                        citizen.identityDocType,
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
                  ]
            }
          />

          <div className="grid gap-x-6 gap-y-6 p-6 sm:grid-cols-2 lg:grid-cols-3">
            <FactSection
              stack
              title={en ? 'Contact' : 'التواصل'}
              facts={[
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
              ]}
            />

            {/*
              «الأسرة» belongs to a household file. A non-resident record is
              asked for none of it (`nonResidentOwnerPersonalSchema`), so
              whatever a converted record still holds is shown below under
              «بيانات محفوظة», where it is labelled as kept rather than current.
            */}
            {isNonResident ? null : (
              <FactSection
                stack
                title={en ? 'Household' : 'الأسرة'}
                facts={householdFacts(citizen, locale)}
              />
            )}

            <FactSection
              stack
              title={en ? 'Registration Information' : 'بيانات التسجيل'}
              facts={[
                {
                  icon: Hash,
                  label: en ? 'Reference Number' : 'الرقم المرجعي',
                  value: citizen.referenceNumber,
                  ltr: true,
                },
                /*
                  نوع الملف, stated rather than left to be inferred from the
                  badge beside the name. It decides which fields this record is
                  ever asked for, so a reviewer wondering why there is no blood
                  type should find the answer written down, not have to know it.
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
              ]}
            />
          </div>
        </div>
      </CollapsibleSection>

      <RetainedHouseholdSection citizen={citizen} locale={locale} />

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

      <CollapsibleSection
        id="properties"
        title={locale === 'en' ? 'Properties' : 'العقارات'}
        icon={FileText}
        defaultOpen={false}
        summary={
          <span className="text-muted-foreground">
            {propertyCount} {locale === 'en' ? 'properties' : 'عقار'}
          </span>
        }
      >
        <div className="space-y-4">

        {citizen.registrations.map((registration) => (
          <Card key={registration.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b">
              <div>
                <CardTitle className="font-mono text-base">
                  {/* Inline `<bdi>` for the same reason as `Fact` below. */}
                  <bdi dir="ltr">{registration.referenceNumber}</bdi>
                </CardTitle>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Calendar className="size-3.5" aria-hidden />
                  {formatDate(registration.submittedAt)}
                </p>
              </div>
            </CardHeader>

            <CardContent className="space-y-4 pt-6">
              {/*
                What this record does not know about itself, said first.

                Above the properties rather than tucked under them, because it
                changes how everything below it should be read: a collector
                looking at a parcel with no رقم العقار needs to know that was a
                decision someone recorded, not a rendering fault or a field
                someone forgot.
              */}
              {registration.flags.length > 0 ? (
                <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
                    <FileQuestion className="size-4 shrink-0" aria-hidden />
                    {locale === 'en'
                      ? `Requires review — ${registration.flags.length} unverified field(s)`
                      : `يتطلب مراجعة — ${registration.flags.length} حقلاً غير مؤكَّد`}
                  </p>
                  <ul className="space-y-1 text-sm">
                    {registration.flags.map((flag) => (
                      <li key={flag.path}>
                        <span className="font-medium">{flagFieldLabel(flag.path, locale)}</span>
                        <span className="text-muted-foreground"> — {flag.reason}</span>
                      </li>
                    ))}
                  </ul>
                  {canEdit ? (
                    <Link
                      href={`${base}/citizens/${citizen.id}/edit`}
                      className="inline-block pt-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {locale === 'en' ? 'Complete this record' : 'استكمال بيانات السجل'}
                    </Link>
                  ) : null}
                </div>
              ) : null}

              {/*
                «ملاحظات» — what the last officer learned by standing there.

                Under the flags and above the properties. It is not a warning,
                so it does not wear the warning colours the flag block does;
                it is frequently the most useful line on the page for whoever
                is about to knock on this door, so it is not buried under the
                property cards either.

                `whitespace-pre-line` because a note is written as a note: line
                breaks the officer typed are part of what they said.
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

              {registration.properties
                .filter((property) => !property.endedAt)
                .map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    base={base}
                    locale={locale}
                    tenant={tenant}
                    token={token}
                    canEdit={canEdit}
                    onChanged={() => void reload()}
                  />
                ))}

              {registration.properties.every((property) => property.endedAt) ? (
                <p className="text-sm text-muted-foreground">
                  {locale === 'en' ? 'No current properties in this application.' : 'لا توجد عقارات قائمة في هذا الطلب.'}
                </p>
              ) : null}

              {/*
                «إيجارات منتهية» — tenancies this person has left.

                Kept on the file with their lease rather than deleted, and set
                apart under their own heading rather than mixed in, so nobody
                counting what this person holds today counts a flat they left.
              */}
              {registration.properties.some((property) => property.endedAt) ? (
                <div className="space-y-3 border-t pt-4">
                  <SubHeading icon={History}>
                    {locale === 'en'
                      ? `Ended tenancies (${registration.properties.filter((property) => property.endedAt).length})`
                      : `إيجارات منتهية (${registration.properties.filter((property) => property.endedAt).length})`}
                  </SubHeading>
                  {registration.properties
                    .filter((property) => property.endedAt)
                    .map((property) => (
                      <PropertyCard
                        key={property.id}
                        property={property}
                        base={base}
                        locale={locale}
                        tenant={tenant}
                        token={token}
                        canEdit={canEdit}
                        onChanged={() => void reload()}
                      />
                    ))}
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
                    {locale === 'en' ? 'No attachments for this application.' : 'لا توجد مرفقات لهذا الطلب.'}
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
                            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate text-sm font-medium">
                              {labels.documentType?.[document.type as never] ?? document.type}
                            </span>
                          </span>
                          {openingDocId === document.id ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                          ) : (
                            <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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

        {citizen.registrations.length === 0 ? (
          <p className="rounded-lg border p-6 text-center text-muted-foreground">
            {locale === 'en' ? 'No registered properties for this citizen.' : 'لا توجد عقارات مسجّلة لهذا المواطن.'}
          </p>
        ) : null}
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

      {/* «ربط مالك بمستأجر», «تسجيل مواطن» and the rest are filed against the
          `User` row this page is showing — see AUDIT_ENTITY.citizen. */}
      <ActivityTrail
        tenant={tenant}
        locale={locale}
        base={base}
        entityType={AUDIT_ENTITY.citizen}
        entityId={citizenId}
      />
    </div>
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
      title={en ? 'Owner to tenants' : 'مالك لدى مستأجرين'}
      icon={UserCheck}
      defaultOpen={false}
      summary={
        <span className="text-muted-foreground">
          {current} {en ? 'linked tenancy card(s)' : 'بطاقة مستأجر مرتبطة'}
          {past > 0 ? (en ? ` · ${past} ended` : ` · ${past} منتهية`) : null}
        </span>
      }
    >
      <ul className="divide-y rounded-lg border">
        {ordered.map((card) => (
          <li key={card.propertyEntryId} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {card.endedAt ? (
                  <Badge variant="soft-muted">
                    {en ? 'Ended ' : 'انتهى في '}
                    {formatDate(card.endedAt)}
                  </Badge>
                ) : null}
                <Badge variant="soft-muted">
                  {card.occupancyType === 'FREE_OCCUPANT'
                    ? en
                      ? 'Free occupant'
                      : 'شاغل بتسامح'
                    : en
                      ? 'Tenant'
                      : 'مستأجر'}
                </Badge>
                <Link
                  href={`${base}/citizens/${card.tenant.id}`}
                  className="font-semibold text-primary underline-offset-4 hover:underline"
                >
                  {card.tenant.name}
                </Link>
                {card.tenant.referenceNumber ? (
                  <bdi dir="ltr" className="font-mono text-xs text-muted-foreground">
                    {card.tenant.referenceNumber}
                  </bdi>
                ) : null}
              </p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {[
                    card.buildingName,
                    card.propertyNumber ? (en ? `Parcel ${card.propertyNumber}` : `العقار ${card.propertyNumber}`) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || (en ? 'No building named' : 'لا اسم للمبنى')}
                </span>
                {card.unitCodes.length > 0 ? (
                  <bdi dir="ltr" className="font-mono">
                    {card.unitCodes.join(', ')}
                  </bdi>
                ) : null}
                {card.linkedAt ? (
                  <span>
                    {en ? 'Linked ' : 'رُبط في '}
                    {formatDate(card.linkedAt)}
                  </span>
                ) : null}
              </p>
            </div>
            {canEdit && token && !card.endedAt ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => setUnlinking(card.propertyEntryId)}
              >
                <Unlink className="size-4" aria-hidden />
                {en ? 'Undo link' : 'إلغاء الربط'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

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
  PAID: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  PENDING_REVIEW:
    'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  UNPAID:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  OVERDUE: 'border-red-600/30 bg-red-600/10 text-red-700 dark:bg-red-500/15 dark:text-red-300',
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
            <span className="text-emerald-600">
              {locale === 'en' ? 'No balance due' : 'لا مستحقات'}
            </span>
          )
        }
      >
        <div className="space-y-6">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Total label={locale === 'en' ? 'Total Billed' : 'إجمالي الرسوم'} value={fees.feesTotal} />
            <Total label={locale === 'en' ? 'Paid' : 'المسدَّد'} value={fees.paidTotal} tone="text-emerald-600" />
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
            <p className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
              <Clock3 className="size-4 shrink-0 text-blue-600" aria-hidden />
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
                            <span className="text-emerald-600">
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
  base,
  locale = 'ar',
  tenant,
  token,
  canEdit,
  onChanged,
}: {
  property: CitizenProfileProperty;
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
      value: property.buildingName,
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

  return (
    <div className={cn('divide-y rounded-lg border', ended ? 'border-dashed bg-background' : 'bg-muted/20')}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
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
            <p className="font-semibold">
              {property.propertyNumber ? (
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
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">
                {labels.propertyType[property.propertyType as never] ?? property.propertyType}
              </Badge>
              <Badge variant={isTenant ? 'warning' : 'outline'}>
                {labels.occupancyType[property.occupancyType as never] ?? property.occupancyType}
              </Badge>
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
          {isNonOwner && !ended && canEdit && token ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none"
              onClick={() => setEndOpen(true)}
            >
              <DoorOpen className="size-4" aria-hidden />
              {isTenant
                ? locale === 'en'
                  ? 'End tenancy'
                  : 'إنهاء الإيجار'
                : locale === 'en'
                  ? 'End occupancy'
                  : 'إنهاء الإشغال'}
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

      {details.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {details.map((fact) => (
            <Fact key={fact.label} {...fact} />
          ))}
        </dl>
      ) : null}

      {isNonOwner && landlord.length > 0 ? (
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SubHeading icon={UserCheck}>{locale === 'en' ? 'Landlord' : 'المالك'}</SubHeading>
            {property.landlordCitizenId && !ended && canEdit && token ? (
              <Button variant="outline" size="sm" className="h-9" onClick={() => setUnlinkOpen(true)}>
                <Unlink className="size-4" aria-hidden />
                {locale === 'en' ? 'Undo link' : 'إلغاء الربط'}
              </Button>
            ) : null}
          </div>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {landlord.map((fact) => (
              <Fact key={fact.label} {...fact} />
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

      {property.units.length > 0 ? (
        <div className="space-y-3 p-4">
          <SubHeading icon={Layers}>
            {locale === 'en'
              ? `Units (${ended ? property.units.length : currentUnits.length})`
              : `الوحدات (${ended ? property.units.length : currentUnits.length})`}
          </SubHeading>
          <ul className="divide-y rounded-lg border bg-background">
            {/* Flats still held first; a flat given up on a current card after them. */}
            {[...currentUnits, ...property.units.filter((unit) => unit.endedAt)].map((unit) => (
              <UnitRow key={unit.id} unit={unit} locale={locale} ended={ended || Boolean(unit.endedAt)} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * «الوحدة» on a citizen's card — what they filed, and what the census says back.
 *
 * Two sources meet on this row and they are not the same claim. The card is the
 * owner's own description of the flat; the linked `Unit` is سجل المباني's, and
 * billing reads the census first (`unitStatus ?? ownerDeclaredStatus`). A row
 * that showed only the card's version was showing the one that loses.
 *
 * Every field here is nullable and every one of them means «لم يُسأل» when it
 * is null — a per-unit «غير مؤكَّد» flag blanks the field it excuses (migration
 * 0031), so a flat an officer could only half describe arrives with no type, no
 * floor and no area. This row rendered those unconditionally, which produced
 * «الطابق » followed by nothing and a bare «م²».
 */
function UnitRow({
  unit,
  locale,
  ended = false,
}: {
  unit: CitizenProfileUnit;
  locale: string;
  /**
   * The tenancy on this flat is over. Its status, vacancy and seasonal lines
   * describe the flat today — somebody else's business now — so they are not
   * shown under a person who no longer lives there.
   */
  ended?: boolean;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  /*
    Shown only when the two disagree. Where the census simply repeats the card,
    a second badge saying the same word twice is noise on a row that already
    carries five things.
  */
  const censusDiffers =
    !ended && unit.censusUnitStatus != null && unit.censusUnitStatus !== unit.unitStatus;

  const seasonalMonths = unit.presenceMonths?.length
    ? formatMonthList(unit.presenceMonths, locale)
    : null;

  return (
    <li className="space-y-1.5 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {unit.unitType ? (
          <Badge variant="secondary" className="shrink-0">
            {labels.unitType[unit.unitType as never] ?? unit.unitType}
          </Badge>
        ) : (
          <Badge variant="soft-warning" className="shrink-0">
            {en ? 'Unit type unverified' : 'نوع الوحدة غير مؤكَّد'}
          </Badge>
        )}

        {/* The census's own name for the flat — what is written on its door. */}
        {unit.unitCode ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Hash className="size-3.5 shrink-0" aria-hidden />
            <bdi dir="ltr" className="font-mono text-xs">
              {unit.unitPostedNumber ?? unit.unitCode}
            </bdi>
          </span>
        ) : null}

        {unit.floor ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Layers className="size-3.5 shrink-0" aria-hidden />
            {en ? `Floor ${unit.floor}` : `الطابق ${unit.floor}`}
          </span>
        ) : null}

        {/*
          Said rather than left out when nobody has measured the flat. A clerk
          reads this row to decide whether a PER_AREA notice can be priced — it
          cannot, against an unmeasured unit (see `assessCitizen`) — and a row
          that simply has no area on it looks like one the page forgot.
        */}
        {unit.unitArea != null ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Ruler className="size-3.5 shrink-0" aria-hidden />
            {unit.unitArea} {en ? 'm²' : 'م²'}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
            <Ruler className="size-3.5 shrink-0" aria-hidden />
            {en ? 'Area not recorded' : 'المساحة غير مسجَّلة'}
          </span>
        )}

        {unit.side ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            {unit.side}
          </span>
        ) : null}

        {unit.sharedRights.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Key className="size-3.5 shrink-0" aria-hidden />
            {unit.sharedRights.join(', ')}
          </span>
        ) : null}

        {unit.unitStatus && !ended ? (
          <Badge variant={unitStatusTone(unit.unitStatus)} className="shrink-0">
            {labels.unitStatus[unit.unitStatus as never] ?? unit.unitStatus}
          </Badge>
        ) : null}

        {unit.endedAt ? (
          <Badge variant="soft-muted" className="shrink-0">
            {en ? 'Left ' : 'تركها في '}
            {formatDate(unit.endedAt)}
          </Badge>
        ) : null}

        {censusDiffers ? (
          <Badge variant={unitStatusTone(unit.censusUnitStatus)} className="shrink-0">
            {en ? 'Census: ' : 'سجل المباني: '}
            {labels.unitStatus[unit.censusUnitStatus as never] ?? unit.censusUnitStatus}
          </Badge>
        ) : null}
      </div>

      {/*
        «تأكيد الشغور» — the reason nobody is being billed for this flat.

        A finding with a consequence, so it is stated with what it rests on and
        when it was made rather than reduced to the word «شاغرة» in a badge: the
        owner disputing a bill and the resident disputing its absence are both
        entitled to read which of the four bases an officer actually had (Shura
        518/2007 — failing to file a declaration does not make an occupied flat
        vacant, and a neighbour's word is not the same evidence as a تصريح).
      */}
      {unit.vacancy && !ended ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-warning/5 px-2 py-1 text-xs text-warning">
          <DoorClosed className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">
            {en ? 'Confirmed vacant' : 'شغور مؤكَّد'} — {formatDate(unit.vacancy.observedAt)}
          </span>
          {unit.vacancy.basis ? (
            <span className="text-muted-foreground">
              {labels.vacancyBasis[unit.vacancy.basis as never] ?? unit.vacancy.basis}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {en ? 'Basis not recorded (backfilled)' : 'دون مستند مسجَّل (سجل مُرحَّل)'}
            </span>
          )}
        </p>
      ) : null}

      {/*
        «مسكن موسمي» — why an owner who is away all year is billed all year.

        The status label says the flat is seasonal; these three say what the
        council's decision to shorten the fee would rest on. Recorded for
        exactly that and read by nothing else, so this page is where they are
        readable at all.
      */}
      {!ended && (unit.unitStatus === 'SEASONAL' || unit.censusUnitStatus === 'SEASONAL') ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 text-xs text-muted-foreground">
          <Sun className="size-3.5 shrink-0" aria-hidden />
          {seasonalMonths ? (
            <span>
              {en ? 'Present: ' : 'أشهر الحضور: '}
              {seasonalMonths}
            </span>
          ) : null}
          {unit.ownerLastStayAt ? (
            <span>
              {en ? 'Last stay ' : 'آخر إقامة '}
              {formatDate(unit.ownerLastStayAt)}
            </span>
          ) : null}
          {unit.vacancyDeclaredAt ? (
            <span>
              {en ? 'Vacancy declared ' : 'تصريح بالشغور '}
              {formatDate(unit.vacancyDeclaredAt)}
            </span>
          ) : null}
          {!seasonalMonths && !unit.ownerLastStayAt && !unit.vacancyDeclaredAt ? (
            <span>
              {en
                ? 'No presence months, last stay or vacancy declaration recorded'
                : 'لم تُسجَّل أشهر الحضور ولا آخر إقامة ولا تصريح بالشغور'}
            </span>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/**
 * A labelled block of facts, absent entirely when the citizen has none of them.
 *
 * `stack` is for the narrow groups that sit side by side as columns: they
 * supply their own spacing from the parent grid, so this adds neither padding
 * nor a second grid inside a grid cell one column wide.
 */
function FactSection({
  title,
  facts,
  stack = false,
}: {
  title: string;
  facts: FactItem[];
  stack?: boolean;
}) {
  const shown = present(facts);
  if (shown.length === 0) return null;
  return (
    <div className={stack ? 'space-y-3' : 'space-y-3 p-6'}>
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <dl className={stack ? 'space-y-4' : 'grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3'}>
        {shown.map((fact) => (
          <Fact key={fact.label} {...fact} />
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
      {phone}
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
      className="inline-flex items-center gap-1.5 font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 hover:underline"
      title="فتح في واتساب"
    >
      <MessageCircle className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <span>{phone}</span>
    </a>
  );
}

/** One labelled value: caption above, value below, so long Arabic labels and
 *  Latin numbers never have to share a baseline. */
function Fact({ icon: Icon, label, value, ltr, hint }: FactItem) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1 break-words font-medium">
        {/*
          `dir` belongs on an inline `<bdi>`, never on the block `<dd>`. A
          block element carrying dir="ltr" also flips its text-align to left,
          so a document number sat at the far edge of its cell while the
          Arabic caption above stayed at the right — the two looked like they
          belonged to different fields. `<bdi>` isolates the digits so they
          still read left-to-right, while the line itself keeps the page's RTL
          alignment and stays under its own label.
        */}
        {ltr ? <bdi dir="ltr">{value}</bdi> : value}
        {/*
          Inside the `<dd>`, not after it: the caveat is part of the value, and
          a `<dl>` that puts loose text between a definition and the next term
          is both invalid and read out as an orphan by a screen reader.
        */}
        {hint ? (
          <span className="mt-0.5 block text-[11px] font-normal leading-snug text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
