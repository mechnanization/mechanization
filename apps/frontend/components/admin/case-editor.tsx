'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, ClipboardList, Loader2, Save } from 'lucide-react';
import {
  CASE_FIELD_MAP,
  createCaseSchema,
  getLabels,
  LAND_TYPE,
  PROPERTY_TYPE,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  createCase,
  getCase,
  logApiError,
  updateCase,
} from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LoadingState } from '@/components/ui/states';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CaseFormValues {
  notes: string;
  propertyNumber: string;
  neighborhood: string;
  propertyType: string;
  buildingName: string;
  floor: string;
  side: string;
  landType: string;
  tentLocation: string;
}

const EMPTY: CaseFormValues = {
  notes: '',
  propertyNumber: '',
  neighborhood: '',
  propertyType: '',
  buildingName: '',
  floor: '',
  side: '',
  landType: '',
  tentLocation: '',
};

/**
 * Log or correct one حالة, on a page of its own.
 *
 * A page rather than a dialog — a dialog that scrolls internally on a phone
 * puts the "حفظ الحالة" button and the field a clerk is typing in two
 * different scroll contexts, which is exactly the friction a form filled out
 * standing at someone's door should not have.
 */
export function CaseEditor({
  tenant,
  locale,
  adminPath,
  /** Absent = creating. */
  caseId,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  caseId?: string;
}) {
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const editing = Boolean(caseId);

  const [token, setToken] = useState<string | null>(null);
  const [values, setValues] = useState<CaseFormValues>(EMPTY);
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const labels = getLabels(locale);
  const cancelHref = `${base}/cases`;

  const handleApiError = useCallback(
    (caught: unknown, fallback: string): string => {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return fallback;
      }
      return caught instanceof ApiRequestError ? caught.message : fallback;
    },
    [tenant, base, router],
  );

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
  }, [tenant, base, router]);

  useEffect(() => {
    if (!token || !caseId) return;
    let cancelled = false;
    setLoading(true);
    getCase(tenant, token, caseId)
      .then((item) => {
        if (cancelled) return;
        setValues({
          notes: item.notes,
          propertyNumber: item.propertyNumber ?? '',
          neighborhood: item.neighborhood ?? '',
          propertyType: item.propertyType ?? '',
          buildingName: item.buildingName ?? '',
          floor: item.floor ?? '',
          side: item.side ?? '',
          landType: item.landType ?? '',
          tentLocation: item.tentLocation ?? '',
        });
      })
      .catch((caught) => {
        if (cancelled) return;
        setLoadError(handleApiError(caught, 'تعذّر تحميل الحالة.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenant, token, caseId, handleApiError]);

  const set = (patch: Partial<CaseFormValues>) =>
    setValues((previous) => ({ ...previous, ...patch }));

  /**
   * Which type-specific fields to show — a plot of land has no floor, a tent
   * has no building name. Switching type also drops whatever the previous
   * type had filled in for a field the new one does not carry, so a stray
   * «الطابق ٣» left over from a BUILDING card never rides along under LAND.
   */
  const visible: readonly string[] = values.propertyType
    ? (CASE_FIELD_MAP[values.propertyType as keyof typeof CASE_FIELD_MAP] ?? [])
    : [];

  const changePropertyType = (propertyType: string) => {
    setValues((previous) => ({
      ...EMPTY,
      notes: previous.notes,
      propertyNumber: previous.propertyNumber,
      neighborhood: previous.neighborhood,
      propertyType,
    }));
  };

  const check = createCaseSchema.shape.notes.safeParse(values.notes);
  const notesError = touched && !check.success ? check.error.issues[0]?.message : undefined;
  const complete = values.notes.trim().length >= 3;

  const submit = useCallback(async () => {
    if (!token) return;
    setTouched(true);
    if (!complete) return;

    setSubmitting(true);
    setError(null);
    const payload = {
      notes: values.notes.trim(),
      ...(values.propertyNumber.trim() ? { propertyNumber: values.propertyNumber.trim() } : {}),
      ...(values.neighborhood.trim() ? { neighborhood: values.neighborhood.trim() } : {}),
      ...(values.propertyType ? { propertyType: values.propertyType } : {}),
      ...(values.buildingName.trim() ? { buildingName: values.buildingName.trim() } : {}),
      ...(values.floor.trim() ? { floor: values.floor.trim() } : {}),
      ...(values.side.trim() ? { side: values.side.trim() } : {}),
      ...(values.landType ? { landType: values.landType } : {}),
      ...(values.tentLocation.trim() ? { tentLocation: values.tentLocation.trim() } : {}),
    };
    try {
      if (caseId) {
        await updateCase(tenant, token, caseId, payload);
      } else {
        await createCase(tenant, token, payload);
      }
      router.push(cancelHref);
    } catch (caught) {
      setError(handleApiError(caught, 'تعذّر حفظ الحالة.'));
    } finally {
      setSubmitting(false);
    }
  }, [token, complete, values, caseId, tenant, router, cancelHref, handleApiError]);

  if (!token) return null;

  if (loadError) {
    return (
      <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {loadError}
        </p>
        <Link href={cancelHref} className={buttonVariants({ variant: 'outline' })}>
          {locale === 'en' ? 'Back to Cases' : 'رجوع إلى الحالات'}
        </Link>
      </div>
    );
  }

  if (loading) return <LoadingState fullHeight />;

  return (
    <div className="w-full space-y-3.5 sm:space-y-6 px-3 py-3 sm:px-6 sm:py-6 lg:px-8 pb-20 sm:pb-8">
      <Link
        href={cancelHref}
        className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-3.5 sm:size-4 rtl:rotate-180" aria-hidden />
        {locale === 'en' ? 'Back to Cases' : 'رجوع إلى الحالات'}
      </Link>

      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 border-b pb-3 sm:pb-4">
        <span
          aria-hidden
          className="flex size-8 sm:size-10 shrink-0 items-center justify-center rounded-lg sm:rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20"
        >
          <ClipboardList className="size-4 sm:size-5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <h1 className="truncate text-base sm:text-2xl font-bold tracking-tight text-foreground">
            {editing
              ? (locale === 'en' ? 'Edit Case' : 'تعديل الحالة')
              : (locale === 'en' ? 'Open a follow-up case' : 'فتح حالة متابعة')}
          </h1>
          <p className="text-[11px] sm:text-xs text-muted-foreground hidden sm:block">
            {locale === 'en'
              ? 'For a visit that could not become a citizen registration — record what was observed so the next visit does not start from zero.'
              : 'لزيارة لم تنتهِ بتسجيل مواطن — سجّل ما أمكن ملاحظته حتى لا تبدأ الزيارة القادمة من الصفر.'}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-5 p-4 sm:p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <Field
            label={locale === 'en' ? 'What happened' : 'ماذا حصل'}
            htmlFor="notes"
            required
            error={notesError}
          >
            <Textarea
              id="notes"
              rows={3}
              value={values.notes}
              onChange={(event) => {
                setTouched(true);
                set({ notes: event.target.value });
              }}
            />
          </Field>

          <div className="grid gap-3.5 sm:gap-5">
            <Field label={locale === 'en' ? 'Property Number' : 'رقم العقار'} htmlFor="propertyNumber">
              <Input
                id="propertyNumber"
                inputMode="numeric"
                dir="ltr"
                className="text-start"
                value={values.propertyNumber}
                onChange={(event) => set({ propertyNumber: event.target.value })}
              />
            </Field>
            <Field label={locale === 'en' ? 'Neighborhood' : 'الحي'} htmlFor="neighborhood">
              <Input
                id="neighborhood"
                value={values.neighborhood}
                onChange={(event) => set({ neighborhood: event.target.value })}
              />
            </Field>
          </div>

          <Field label={locale === 'en' ? 'Property Type' : 'نوع العقار'} htmlFor="propertyType">
            <Select
              value={values.propertyType || '__none'}
              onValueChange={(next) => changePropertyType(next === '__none' ? '' : next)}
            >
              <SelectTrigger id="propertyType">
                <SelectValue placeholder={locale === 'en' ? 'Unknown' : 'غير معروف'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">{locale === 'en' ? 'Unknown' : 'غير معروف'}</SelectItem>
                {PROPERTY_TYPE.map((type) => (
                  <SelectItem key={type} value={type}>
                    {labels.propertyType[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/*
            Each نوع العقار has different attributes, exactly like the citizen
            registration form's property card — a plot of land has no floor, a
            tent has no building name, so only what applies to the chosen type
            is asked.
          */}
          {visible.includes('buildingName') || visible.includes('side') ? (
            <div className="grid gap-3.5 sm:gap-5">
              {visible.includes('buildingName') ? (
                <Field
                  label={locale === 'en' ? 'Building / House Name' : 'اسم المبنى/المنزل'}
                  htmlFor="buildingName"
                >
                  <Input
                    id="buildingName"
                    value={values.buildingName}
                    onChange={(event) => set({ buildingName: event.target.value })}
                  />
                </Field>
              ) : null}
              {visible.includes('side') ? (
                <Field label={locale === 'en' ? 'Side / Orientation' : 'الجهة'} htmlFor="side">
                  <Input
                    id="side"
                    placeholder={locale === 'en' ? 'e.g. North, South' : 'مثال: شمالي، جنوبي'}
                    value={values.side}
                    onChange={(event) => set({ side: event.target.value })}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          {visible.includes('floor') ? (
            <Field label={locale === 'en' ? 'Floor' : 'الطابق'} htmlFor="floor">
              <Input
                id="floor"
                value={values.floor}
                onChange={(event) => set({ floor: event.target.value })}
              />
            </Field>
          ) : null}

          {visible.includes('landType') ? (
            <Field label={locale === 'en' ? 'Land Type' : 'نوع الأرض'} htmlFor="landType">
              <Select
                value={values.landType || '__none'}
                onValueChange={(next) => set({ landType: next === '__none' ? '' : next })}
              >
                <SelectTrigger id="landType">
                  <SelectValue placeholder={locale === 'en' ? 'Unknown' : 'غير معروف'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{locale === 'en' ? 'Unknown' : 'غير معروف'}</SelectItem>
                  {LAND_TYPE.map((type) => (
                    <SelectItem key={type} value={type}>
                      {labels.landType[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {visible.includes('tentLocation') ? (
            <Field
              label={locale === 'en' ? 'Tent Location Description' : 'وصف موقع الخيمة'}
              htmlFor="tentLocation"
            >
              <Input
                id="tentLocation"
                placeholder={locale === 'en' ? 'e.g. North Camp — Plot 4' : 'مثال: المخيم الشمالي — قطعة ٤'}
                value={values.tentLocation}
                onChange={(event) => set({ tentLocation: event.target.value })}
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end sm:gap-3">
        <Link href={cancelHref} className={buttonVariants({ variant: 'outline' })}>
          {locale === 'en' ? 'Cancel' : 'إلغاء'}
        </Link>
        <Button disabled={submitting} onClick={() => void submit()}>
          {submitting ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          {editing
            ? (locale === 'en' ? 'Save Changes' : 'حفظ التعديلات')
            : (locale === 'en' ? 'Save Case' : 'حفظ الحالة')}
        </Button>
      </div>
    </div>
  );
}
