'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowRight,
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
  Tent,
  Trees,
  User,
  UserCheck,
  Users,
  Wallet,
} from 'lucide-react';
import { getLabels, isUnoccupied } from '@mechanization/shared-schemas';
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
  CitizenProfilePayment,
  CitizenProfileProperty,
  MunicipalitySettings,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { useToast } from '@/components/ui/toast';
import { findLocatedProperty, mapHref } from '@/lib/map-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { LoadingState } from '@/components/ui/states';
import {
  SettlePaymentDialog,
  type SettleValues,
} from '@/components/admin/settle-payment-dialog';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { buildCitizenWelcomeMessage, buildWhatsappHref } from '@/lib/whatsapp';

/** One glyph per property branch, so a card's kind is readable before its text. */
const PROPERTY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  BUILDING: Building2,
  HOUSE: Home,
  LAND: Trees,
  TENT: Tent,
};

interface FactItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: React.ReactNode;
  /** Latin-script content (numbers, phones) that must not mirror in RTL. */
  ltr?: boolean;
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
 * `properties.1.propertyNumber` → «رقم العقار — العقار ٢».
 *
 * A stored flag names a path, which is the right thing to store and the wrong
 * thing to read: nobody reviewing a household's file thinks in dot-paths. The
 * card number is 1-based here because that is how the cards are labelled on
 * the form the officer filled in.
 */
function flagFieldLabel(path: string, locale: string): string {
  const labels = getLabels(locale);
  const segments = path.split('.');
  const field = labels.citizenField[segments.at(-1) ?? ''] ?? segments.at(-1) ?? path;

  if (segments[0] !== 'properties') return field;
  const card = Number(segments[1]) + 1;
  return locale === 'en' ? `${field} — property ${card}` : `${field} — العقار ${card}`;
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

  const propertyCount = citizen.registrations.reduce(
    (total, registration) => total + registration.properties.length,
    0,
  );

  const locatedProperty = findLocatedProperty(
    citizen.registrations.flatMap((registration) => registration.properties),
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
      <Link
        href={`${base}/citizens`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
        {locale === 'en' ? 'Back to Citizens Registry' : 'رجوع إلى سجل المواطنين'}
      </Link>

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
              {citizen.gender ? (
                <Badge variant="outline">{labels.gender[citizen.gender as never] ?? citizen.gender}</Badge>
              ) : null}
              {citizen.bloodType ? (
                <Badge variant="outline" className="border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400">
                  <Droplet className="me-1 size-3" />
                  {labels.bloodType?.[citizen.bloodType as never] ?? citizen.bloodType}
                </Badge>
              ) : null}
              {citizen.residentStatus ? (
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
        title={locale === 'en' ? 'Personal Details' : 'البيانات الشخصية'}
        icon={IdCard}
        className="[&_summary]:pb-4"
        summary={
          <span className="text-muted-foreground">
            {citizen.identityDocNumber ? (
              <bdi dir="ltr">{citizen.identityDocNumber}</bdi>
            ) : null}
          </span>
        }
      >
        <div className="-m-5 divide-y">
          <FactSection
            title={locale === 'en' ? 'Identity' : 'الهوية'}
            facts={[
              {
                icon: User,
                label: locale === 'en' ? 'Name' : 'الاسم',
                value: citizen.fullName,
              },
              {
                icon: User,
                label: locale === 'en' ? 'Gender' : 'الجنس',
                value: labels.gender[citizen.gender as never] ?? citizen.gender,
              },
              {
                icon: Droplet,
                label: locale === 'en' ? 'Blood Type' : 'فئة الدم',
                value: citizen.bloodType
                  ? (labels.bloodType?.[citizen.bloodType as never] ?? citizen.bloodType)
                  : undefined,
              },
              {
                icon: Flag,
                label: locale === 'en' ? 'Nationality' : 'الجنسية',
                value: citizen.nationality,
              },
              {
                icon: Home,
                label: locale === 'en' ? 'Residency Status' : 'صفة الإقامة',
                value: labels.residentStatus[citizen.residentStatus as never] ?? citizen.residentStatus,
              },
              {
                icon: IdCard,
                label: locale === 'en' ? 'ID Document Type' : 'نوع وثيقة الإثبات',
                value: labels.identityDocType[citizen.identityDocType as never] ?? citizen.identityDocType,
              },
              {
                icon: FileDigit,
                label: locale === 'en' ? 'Document Number' : 'رقم الوثيقة',
                value: citizen.identityDocNumber,
                ltr: true,
              },
              citizen.isLebanese
                ? {
                    icon: FileDigit,
                    label: locale === 'en' ? 'Civil Record (Sijil) No.' : 'رقم السجل',
                    value: citizen.civilRecordNumber,
                    ltr: true,
                  }
                : {
                    icon: FileDigit,
                    label: locale === 'en' ? 'Residency Permit No.' : 'رقم الإقامة',
                    value: citizen.residencyNumber,
                    ltr: true,
                  },
            ]}
          />

          <div className="grid gap-x-6 gap-y-6 p-6 sm:grid-cols-2 lg:grid-cols-3">
            <FactSection
              stack
              title={locale === 'en' ? 'Contact' : 'التواصل'}
              facts={[
                {
                  icon: Phone,
                  label: locale === 'en' ? 'Phone' : 'الهاتف',
                  value: citizen.phone ? <PhoneLink phone={citizen.phone} /> : null,
                },
                {
                  icon: MessageCircle,
                  label: locale === 'en' ? 'WhatsApp' : 'واتساب',
                  value: citizen.whatsapp ? (
                    <WhatsAppPhoneLink phone={citizen.whatsapp} message={waMessage} />
                  ) : null,
                },
              ]}
            />

            <FactSection
              stack
              title={locale === 'en' ? 'Household' : 'الأسرة'}
              facts={[
                {
                  icon: Heart,
                  label: locale === 'en' ? 'Marital Status' : 'الحالة الاجتماعية',
                  value: citizen.maritalStatus
                    ? (labels.maritalStatus?.[citizen.maritalStatus as never] ?? citizen.maritalStatus)
                    : undefined,
                },
                {
                  icon: Users,
                  label:
                    locale === 'en'
                      ? 'Family Members (Living in House)'
                      : 'عدد أفراد الأسرة (المقيمين في المنزل)',
                  value: (citizen.actualHouseholdMembers ?? citizen.totalRegisteredMembers)?.toString(),
                },
                ...(citizen.totalRegisteredMembers != null &&
                citizen.actualHouseholdMembers != null &&
                citizen.totalRegisteredMembers > citizen.actualHouseholdMembers
                  ? [
                      {
                        icon: Users,
                        label:
                          locale === 'en'
                            ? 'Total Registered (Civil Record)'
                            : 'إجمالي المسجلين في القيد',
                        value: citizen.totalRegisteredMembers.toString(),
                      },
                      {
                        icon: Users,
                        label:
                          locale === 'en' ? 'Married Children (Independent)' : 'الأبناء المتزوجون المستقلون',
                        value: citizen.marriedChildrenCount?.toString(),
                      },
                    ]
                  : []),
              ]}
            />

            <FactSection
              stack
              title={locale === 'en' ? 'Registration Information' : 'بيانات التسجيل'}
              facts={[
                {
                  icon: Hash,
                  label: locale === 'en' ? 'Reference Number' : 'الرقم المرجعي',
                  value: citizen.referenceNumber,
                  ltr: true,
                },
                {
                  icon: Calendar,
                  label: locale === 'en' ? 'First Registered' : 'تاريخ أول تسجيل',
                  value: formatDate(citizen.registeredAt),
                },
              ]}
            />
          </div>
        </div>
      </CollapsibleSection>

      <FeesPanel
        citizen={citizen}
        payments={citizen.payments}
        fees={citizen.fees}
        canManage={canManage}
        municipalityName={municipalityName}
        governorate={settings?.governorate}
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

              {registration.properties.map((property) => (
                <PropertyCard key={property.id} property={property} base={base} locale={locale} />
              ))}

              {registration.properties.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {locale === 'en' ? 'No properties in this application.' : 'لا توجد عقارات في هذا الطلب.'}
                </p>
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
    </div>
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
}: {
  property: CitizenProfileProperty;
  base: string;
  locale?: string;
}) {
  const Icon = PROPERTY_ICON[property.propertyType] ?? Building2;
  const isTenant = property.occupancyType === 'TENANT';
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
      value: property.unitStatus
        ? (labels.unitStatus[property.unitStatus as never] ?? property.unitStatus)
        : null,
    },
  ]);

  const landlord = present([
    {
      icon: User,
      label: locale === 'en' ? 'Landlord Name' : 'اسم المالك',
      value: property.landlordName,
    },
    {
      icon: Phone,
      label: locale === 'en' ? 'Landlord Phone' : 'هاتف المالك',
      value: property.landlordPhone ? <PhoneLink phone={property.landlordPhone} /> : null,
    },
  ]);

  return (
    <div className="divide-y rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
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
            </div>
          </div>
        </div>

        {property.latitude != null ? (
          <Link
            href={mapHref(base, property)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <MapPin className="size-3.5" aria-hidden />
            {locale === 'en' ? 'View on Map' : 'عرض على الخريطة'}
          </Link>
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
          <SubHeading icon={UserCheck}>{locale === 'en' ? 'Landlord' : 'المالك'}</SubHeading>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {landlord.map((fact) => (
              <Fact key={fact.label} {...fact} />
            ))}
          </dl>
        </div>
      ) : null}

      {property.units.length > 0 ? (
        <div className="space-y-3 p-4">
          <SubHeading icon={Layers}>
            {locale === 'en' ? `Units (${property.units.length})` : `الوحدات (${property.units.length})`}
          </SubHeading>
          <ul className="divide-y rounded-lg border bg-background">
            {property.units.map((unit) => (
              <li key={unit.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
                <Badge variant="secondary" className="shrink-0">
                  {labels.unitType[unit.unitType as never] ?? unit.unitType}
                </Badge>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Layers className="size-3.5 shrink-0" aria-hidden />
                  {locale === 'en' ? `Floor ${unit.floor}` : `الطابق ${unit.floor}`}
                </span>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Ruler className="size-3.5 shrink-0" aria-hidden />
                  {unit.unitArea} {locale === 'en' ? 'm²' : 'م²'}
                </span>
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
                {unit.unitStatus ? (
                  <Badge
                    variant={isUnoccupied(unit.unitStatus) ? 'warning' : 'outline'}
                    className="shrink-0"
                  >
                    {labels.unitStatus[unit.unitStatus as never] ?? unit.unitStatus}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
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
function Fact({ icon: Icon, label, value, ltr }: FactItem) {
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
      </dd>
    </div>
  );
}
