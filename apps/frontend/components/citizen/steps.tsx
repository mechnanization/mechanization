'use client';

import { useCallback, useEffect } from 'react';
import {
  BLOOD_TYPE,
  GENDER,
  getLabels,
  MARITAL_STATUS,
  RESIDENT_STATUS,
} from '@mechanization/shared-schemas';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';

type Values = Record<string, unknown>;
type Errors = Record<string, string>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Step 1 — البيانات الشخصية ومعلومات الإثبات */
export function PersonalStep({
  value,
  errors,
  onChange,
  locale = 'ar',
}: {
  value: Values;
  errors: Errors;
  onChange: (next: Values) => void;
  locale?: string;
}) {
  const labels = getLabels(locale);
  const set = useCallback((patch: Values) => onChange({ ...value, ...patch }), [onChange, value]);
  const isLebanese = value.isLebanese !== false;

  /**
   * صفة الإقامة options a Lebanese citizen may choose from. لاجئ describes
   * someone displaced from outside Lebanon — a Lebanese citizen cannot hold
   * that status, so the choice is not offered once لبناني is selected.
   */
  const residentStatusOptions = isLebanese
    ? RESIDENT_STATUS.filter((status) => status !== 'REFUGEE')
    : RESIDENT_STATUS;

  useEffect(() => {
    if (isLebanese) {
      const patch: Values = {};
      if (value.nationality !== 'لبناني' && value.nationality !== 'Lebanese') {
        patch.nationality = locale === 'en' ? 'Lebanese' : 'لبناني';
      }
      if (value.residentStatus === 'REFUGEE') patch.residentStatus = undefined;
      if (Object.keys(patch).length > 0) set(patch);
    } else if (value.identityDocType !== 'PASSPORT') {
      /*
        The one document still asked for is a non-Lebanese passport. A number
        filed under any other type — a Lebanese national ID on a record whose
        nationality is being corrected — is not a passport number, so it is not
        shown in the passport box. It is not erased either: the edit never sends
        what this form does not ask (`citizenColumnsForEdit`).
      */
      set({ identityDocType: 'PASSPORT', identityDocNumber: '' });
    }
  }, [isLebanese, value.nationality, value.residentStatus, value.identityDocType, locale, set]);

  /** «إلزامي إن وجد» — see `Field.optionalLabel`. */
  const ifHeld = locale === 'en' ? '(required if held)' : '(إلزامي إن وجد)';

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* 1. Name block */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label={locale === 'en' ? 'First Name' : 'الاسم الأول'}
          htmlFor="firstName"
          path="personal.firstName"
          required
          error={errors['personal.firstName']}
        >
          <Input
            id="firstName"
            autoComplete="given-name"
            placeholder={locale === 'en' ? 'e.g. Ahmad' : 'مثال: أحمد'}
            invalid={Boolean(errors['personal.firstName'])}
            value={str(value.firstName)}
            onChange={(e) => set({ firstName: e.target.value })}
          />
        </Field>

        <Field
          label={locale === 'en' ? "Father's Name" : 'اسم الأب'}
          htmlFor="middleName"
          path="personal.middleName"
          required
          error={errors['personal.middleName']}
        >
          <Input
            id="middleName"
            autoComplete="additional-name"
            placeholder={locale === 'en' ? 'e.g. Mohammad' : 'مثال: محمد'}
            invalid={Boolean(errors['personal.middleName'])}
            value={str(value.middleName)}
            onChange={(e) => set({ middleName: e.target.value })}
          />
        </Field>

        <Field
          label={locale === 'en' ? 'Last Name' : 'الشهرة'}
          htmlFor="lastName"
          path="personal.lastName"
          required
          error={errors['personal.lastName']}
        >
          <Input
            id="lastName"
            autoComplete="family-name"
            placeholder={locale === 'en' ? 'e.g. Srour' : 'مثال: سرور'}
            invalid={Boolean(errors['personal.lastName'])}
            value={str(value.lastName)}
            onChange={(e) => set({ lastName: e.target.value })}
          />
        </Field>
      </div>

      {/* 2. Nationality & Gender - Instant 1-tap segment on mobile */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field
          label={locale === 'en' ? 'Nationality' : 'الجنسية'}
          htmlFor="isLebanese"
          path="personal.isLebanese"
          required
          error={errors['personal.isLebanese']}
        >
          <SegmentedControl
            value={isLebanese ? 'LEBANESE' : 'FOREIGN'}
            invalid={Boolean(errors['personal.isLebanese'])}
            onChange={(next) => {
              const isLeb = next === 'LEBANESE';
              if (isLeb) {
                set({ isLebanese: true, residencyNumber: undefined });
              } else {
                set({ isLebanese: false, civilRecordNumber: undefined });
              }
            }}
            options={[
              { value: 'LEBANESE', label: locale === 'en' ? 'Lebanese' : 'لبناني' },
              { value: 'FOREIGN', label: locale === 'en' ? 'Non-Lebanese' : 'غير لبناني' },
            ]}
          />
        </Field>

        <Field
          label={locale === 'en' ? 'Gender' : 'الجنس'}
          htmlFor="gender"
          path="personal.gender"
          required
          error={errors['personal.gender']}
        >
          <SegmentedControl
            value={str(value.gender)}
            invalid={Boolean(errors['personal.gender'])}
            onChange={(next) => set({ gender: next })}
            options={GENDER.map((g) => ({
              value: g,
              label: labels.gender[g] ?? g,
            }))}
          />
        </Field>
      </div>

      {/* 3. Residency Status - Full-width 1-tap segment */}
      <Field
        label={locale === 'en' ? 'Residency Status' : 'صفة الإقامة'}
        htmlFor="residentStatus"
        path="personal.residentStatus"
        required
        error={errors['personal.residentStatus']}
      >
        <SegmentedControl
          value={str(value.residentStatus)}
          invalid={Boolean(errors['personal.residentStatus'])}
          onChange={(next) => set({ residentStatus: next })}
          options={residentStatusOptions.map((option) => ({
            value: option,
            label: labels.residentStatus[option] ?? option,
          }))}
        />
      </Field>

      {/* Specific Nationality if non-Lebanese */}
      {!isLebanese ? (
        <Field
          label={locale === 'en' ? 'Specific Nationality' : 'الجنسية بالتفصيل'}
          htmlFor="nationality"
          path="personal.nationality"
          required
          error={errors['personal.nationality']}
        >
          <Input
            id="nationality"
            placeholder={locale === 'en' ? 'e.g. Syrian, Palestinian, Egyptian' : 'مثال: سوري، فلسطيني، مصري'}
            invalid={Boolean(errors['personal.nationality'])}
            value={value.nationality === 'لبناني' || value.nationality === 'Lebanese' ? '' : str(value.nationality)}
            onChange={(e) => set({ nationality: e.target.value })}
          />
        </Field>
      ) : null}

      {/*
        4. رقم السجل, and for a non-Lebanese person their passport and residency.

        No identity document is asked of a Lebanese citizen any more. Officers
        were told it was not required and filled it with shared or invented
        numbers, and because citizens were matched on it, a repeated number
        merged different people into one record. رقم السجل stays: it is what the
        civil registry knows the household by.

        A non-Lebanese person's two numbers are «إلزامي إن وجد»: both may be
        empty together, and neither may be made up.
      */}
      {isLebanese ? (
        <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/10 p-3 sm:grid-cols-2 sm:p-4">
          <Field
            label={locale === 'en' ? 'Civil Record (Sijil) No.' : 'رقم السجل (القيد)'}
            htmlFor="civilRecordNumber"
            path="personal.civilRecordNumber"
            required
            error={errors['personal.civilRecordNumber']}
          >
            <Input
              id="civilRecordNumber"
              inputMode="numeric"
              dir="ltr"
              placeholder={locale === 'en' ? 'e.g. 42' : 'مثال: ٤٢'}
              className="text-start"
              invalid={Boolean(errors['personal.civilRecordNumber'])}
              value={str(value.civilRecordNumber)}
              onChange={(e) => set({ civilRecordNumber: e.target.value })}
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-border/70 bg-muted/10 p-3 sm:p-4">
          <Field
            label={locale === 'en' ? 'Passport No.' : 'رقم جواز السفر'}
            optionalLabel={ifHeld}
            htmlFor="identityDocNumber"
            path="personal.identityDocNumber"
            error={errors['personal.identityDocNumber']}
          >
            <Input
              id="identityDocNumber"
              dir="ltr"
              placeholder="Passport number"
              className="text-start"
              invalid={Boolean(errors['personal.identityDocNumber'])}
              value={str(value.identityDocNumber)}
              onChange={(e) => set({ identityDocNumber: e.target.value })}
            />
          </Field>

          <Field
            label={locale === 'en' ? 'Residency Permit No.' : 'رقم الإقامة'}
            optionalLabel={ifHeld}
            htmlFor="residencyNumber"
            path="personal.residencyNumber"
            error={errors['personal.residencyNumber']}
          >
            <Input
              id="residencyNumber"
              inputMode="numeric"
              dir="ltr"
              placeholder="Residency number"
              className="text-start"
              invalid={Boolean(errors['personal.residencyNumber'])}
              value={str(value.residencyNumber)}
              onChange={(e) => set({ residencyNumber: e.target.value })}
            />
          </Field>
        </div>
      )}

      {/* 5. Blood Type */}
      <Field
        label={locale === 'en' ? 'Blood Type' : 'فئة الدم'}
        htmlFor="bloodType"
        path="personal.bloodType"
        required
        error={errors['personal.bloodType']}
      >
        <Select
          value={str(value.bloodType)}
          onValueChange={(next) => set({ bloodType: next })}
        >
          <SelectTrigger id="bloodType" className={errors['personal.bloodType'] ? 'border-destructive' : ''}>
            <SelectValue placeholder={locale === 'en' ? 'Select blood type…' : 'اختر فئة الدم…'} />
          </SelectTrigger>
          <SelectContent side="bottom" position="popper">
            {BLOOD_TYPE.map((type) => (
              <SelectItem key={type} value={type}>
                {labels.bloodType?.[type] ?? type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

/** Step 2 — معلومات التواصل والأسرة */
export function ContactStep({
  value,
  errors,
  onChange,
  locale = 'ar',
}: {
  value: Values;
  errors: Errors;
  onChange: (next: Values) => void;
  locale?: string;
}) {
  const labels = getLabels(locale);
  const set = (patch: Values) => onChange({ ...value, ...patch });
  const sameAsPhone = value.whatsappSameAsPhone !== false;

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* 1. Phone & WhatsApp - Top priority for field surveys */}
      <div className="space-y-3 rounded-lg border border-border/70 bg-card p-3 sm:p-4">
        <Field
          label={locale === 'en' ? 'Primary Phone Number' : 'رقم الهاتف الأساسي'}
          htmlFor="phone"
          path="contact.phone"
          required
          error={errors['contact.phone']}
          /*
            Said once, where the number is typed.

            A Lebanese number needs no code and never has — asking for one on
            every registration to accommodate the rare foreign number would
            slow down every registration in the municipality. The hint exists
            for the other direction: somebody holding an owner's number in
            Abidjan has no way to guess that a `+` is what makes it accepted,
            and the field used to simply refuse them with «رقم الهاتف غير صالح».
          */
          hint={
            locale === 'en'
              ? 'A Lebanese number needs no country code. For any other country, start with + and the code.'
              : 'الرقم اللبناني لا يحتاج رمز الدولة. لرقم من دولة أخرى، ابدأ بـ + ثم رمز الدولة.'
          }
        >
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            placeholder="03 123456 / +33 6 12 34 56 78"
            className="text-start"
            invalid={Boolean(errors['contact.phone'])}
            value={str(value.phone)}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>

        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="whatsapp" className="text-xs font-medium text-foreground/90">
              {locale === 'en' ? 'WhatsApp Number' : 'رقم الواتساب'}
            </Label>
            <label htmlFor="whatsappSameAsPhone" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
              <Checkbox
                id="whatsappSameAsPhone"
                checked={sameAsPhone}
                onCheckedChange={(checked) => set({ whatsappSameAsPhone: checked === true })}
              />
              <span className="font-medium">{locale === 'en' ? 'Same as phone' : 'نفس رقم الهاتف'}</span>
            </label>
          </div>

          {!sameAsPhone ? (
            <Input
              id="whatsapp"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              dir="ltr"
              placeholder="70 123456 / +33 6 12 34 56 78"
              className="text-start"
              invalid={Boolean(errors['contact.whatsapp'])}
              value={str(value.whatsapp)}
              onChange={(e) => set({ whatsapp: e.target.value })}
            />
          ) : (
            <div className="flex h-10 items-center rounded-md border border-dashed border-border/80 bg-muted/20 px-3 text-xs text-muted-foreground">
              {locale === 'en' ? '✓ Using primary phone for WhatsApp' : '✓ يتم استخدام رقم الهاتف الأساسي للواتساب'}
            </div>
          )}
          {errors['contact.whatsapp'] ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-xs text-destructive">
              {errors['contact.whatsapp']}
            </p>
          ) : null}
        </div>
      </div>

      {/* 2. Marital Status & Family size */}
      <Field
        label={locale === 'en' ? 'Marital Status' : 'الحالة الاجتماعية'}
        htmlFor="maritalStatus"
        path="contact.maritalStatus"
        required
        error={errors['contact.maritalStatus']}
      >
        <SegmentedControl
          value={str(value.maritalStatus)}
          invalid={Boolean(errors['contact.maritalStatus'])}
          onChange={(next) => set({ maritalStatus: next })}
          options={MARITAL_STATUS.map((o) => ({
            value: o,
            label: labels.maritalStatus[o] ?? o,
          }))}
        />
      </Field>

      <Field
        label={
          locale === 'en'
            ? 'Family Members Living in the House (without married children)'
            : 'عدد أفراد الأسرة المقيمين في المنزل (دون المتزوجين)'
        }
        htmlFor="actualHouseholdMembers"
        path="contact.actualHouseholdMembers"
        required
        error={errors['contact.actualHouseholdMembers']}
      >
        <Input
          id="actualHouseholdMembers"
          inputMode="numeric"
          dir="ltr"
          placeholder={locale === 'en' ? 'e.g. 4' : 'مثال: ٤'}
          className="text-start max-w-xs"
          invalid={Boolean(errors['contact.actualHouseholdMembers'])}
          value={str(value.actualHouseholdMembers)}
          /*
            `totalRegisteredMembers` is written from this one field and is no
            longer asked for separately.

            The form used to ask twice — once for the قيد العائلي headcount
            including married children, once for who actually sleeps in the
            house — and showed the subtraction between them as a read-only
            «عدد الأبناء المتزوجين المستقلين (تلقائي)». The municipality only
            registers the resident household now, so the second number has no
            one to supply it and the subtraction had nothing left to mean: it
            sat under the field reading 0 on every record.

            Kept mirrored rather than dropped because the column is still
            written, read by `reporting.service`'s `marriedOffspringTotal` and
            shown on the citizen's file. Leaving it unset would let the schema
            default it to `actualHouseholdMembers` on a create — the same value
            — but would strand an *edit* of an older record at whatever gross
            total it was filed with, so correcting the resident count from 5 to
            3 would silently report two married children who were never
            entered. Writing both keeps the derived figure at 0, which is what
            «دون المتزوجين» now means for every record this form touches.
          */
          onChange={(e) =>
            set({
              actualHouseholdMembers: e.target.value,
              totalRegisteredMembers: e.target.value,
            })
          }
        />
      </Field>
    </div>
  );
}

/** Step 4 — المستندات */

/*
 * `DocumentsStep`, `ReviewStep` and `DeclarationStep` were here, along with
 * the `FileField` / `ReviewBlock` helpers they used.
 *
 * They were steps 4, 5 and 6 of the citizen wizard: attach the proofs,
 * re-read everything, then sign the الإقرار and send. A clerk entering a
 * record from papers on the counter has no browser `File` objects to attach,
 * reviews the form itself rather than a summary of it, and cannot sign a
 * declaration on someone else's behalf — so all three lost their subject
 * with the wizard.
 *
 * The two that remain are shared: `CitizenForm` renders them as sections 1
 * and 2 of the staff entry page, which is what keeps the conditional fields
 * (رقم السجل only for a Lebanese citizen, صفة الإقامة gating خيمة) identical
 * to what the wizard enforced.
 */
// ─────────────  «غير مقيم في البلدة» — a non-resident record  ─────────────

/**
 * Who a non-resident is, and where they live — an owner who lives elsewhere, or
 * somebody who runs a shop, an office or a clinic here, or farms a plot, and
 * goes home to another town. The component names still say «Owner» because the
 * record began as an owner record; see `CITIZEN_RESIDENCE`.
 *
 * Everything a household file asks and this does not — identity document,
 * رقم السجل, blood type, nationality, صفة الإقامة — is left out on purpose, not
 * flagged as missing: the rental-value fee falls on whoever occupies the unit
 * (Law 60/1988, Art. 3–4), and what the law wants about an owner is a name on
 * the roll and where they live (Art. 14, 17). See
 * `nonResidentOwnerPersonalSchema`.
 */
export function OwnerPersonalStep({
  value,
  errors,
  onChange,
  locale = 'ar',
}: {
  value: Values;
  errors: Errors;
  onChange: (next: Values) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const set = (patch: Values) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label={en ? 'First Name' : 'الاسم الأول'}
          htmlFor="owner-firstName"
          path="personal.firstName"
          required
          error={errors['personal.firstName']}
        >
          <Input
            id="owner-firstName"
            invalid={Boolean(errors['personal.firstName'])}
            value={str(value.firstName)}
            onChange={(e) => set({ firstName: e.target.value })}
          />
        </Field>
        <Field
          label={en ? "Father's Name" : 'اسم الأب'}
          htmlFor="owner-middleName"
          path="personal.middleName"
          error={errors['personal.middleName']}
        >
          <Input
            id="owner-middleName"
            invalid={Boolean(errors['personal.middleName'])}
            value={str(value.middleName)}
            onChange={(e) => set({ middleName: e.target.value })}
          />
        </Field>
        <Field
          label={en ? 'Last Name' : 'الشهرة'}
          htmlFor="owner-lastName"
          path="personal.lastName"
          required
          error={errors['personal.lastName']}
        >
          <Input
            id="owner-lastName"
            invalid={Boolean(errors['personal.lastName'])}
            value={str(value.lastName)}
            onChange={(e) => set({ lastName: e.target.value })}
          />
        </Field>
      </div>

      <Field
        label={en ? 'Where they live' : 'مكان الإقامة'}
        htmlFor="owner-residencePlace"
        path="personal.residencePlace"
        required
        error={errors['personal.residencePlace']}
        hint={
          en
            ? 'A town or a country — where they live most of the year.'
            : 'بلدة أو دولة — حيث يقيم معظم السنة.'
        }
      >
        <Input
          id="owner-residencePlace"
          placeholder={en ? 'e.g. Beirut, Ivory Coast' : 'مثال: بيروت، ساحل العاج'}
          invalid={Boolean(errors['personal.residencePlace'])}
          value={str(value.residencePlace)}
          onChange={(e) => set({ residencePlace: e.target.value })}
        />
      </Field>
    </div>
  );
}

/**
 * How to reach a non-resident — their own number, and optionally somebody local:
 * the relative or caretaker with an owner's keys, or whoever runs a shop day to
 * day for a tenant who is rarely in it.
 */
export function OwnerContactStep({
  value,
  errors,
  onChange,
  locale = 'ar',
}: {
  value: Values;
  errors: Errors;
  onChange: (next: Values) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const set = (patch: Values) => onChange({ ...value, ...patch });
  const sameAsPhone = value.whatsappSameAsPhone !== false;

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="space-y-3 rounded-lg border border-border/70 bg-card p-3 sm:p-4">
        <Field
          label={en ? 'Phone' : 'رقم الهاتف'}
          htmlFor="owner-phone"
          path="contact.phone"
          required
          error={errors['contact.phone']}
          hint={
            en
              ? 'Usually a foreign number — start with + and the country code.'
              : 'غالباً رقم خارج لبنان — ابدأ بـ + ثم رمز الدولة.'
          }
        >
          <Input
            id="owner-phone"
            type="tel"
            inputMode="tel"
            dir="ltr"
            placeholder="+225 07 12 34 56 78"
            className="text-start"
            invalid={Boolean(errors['contact.phone'])}
            value={str(value.phone)}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>

        <label
          htmlFor="owner-whatsappSameAsPhone"
          className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Checkbox
            id="owner-whatsappSameAsPhone"
            checked={sameAsPhone}
            onCheckedChange={(checked) => set({ whatsappSameAsPhone: checked === true })}
          />
          <span className="font-medium">{en ? 'WhatsApp on the same number' : 'واتساب على الرقم نفسه'}</span>
        </label>

        {!sameAsPhone ? (
          <Field
            label={en ? 'WhatsApp Number' : 'رقم الواتساب'}
            htmlFor="owner-whatsapp"
            path="contact.whatsapp"
            required
            error={errors['contact.whatsapp']}
          >
            <Input
              id="owner-whatsapp"
              type="tel"
              inputMode="tel"
              dir="ltr"
              className="text-start"
              invalid={Boolean(errors['contact.whatsapp'])}
              value={str(value.whatsapp)}
              onChange={(e) => set({ whatsapp: e.target.value })}
            />
          </Field>
        ) : null}
      </div>

      <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/10 p-3 sm:grid-cols-2 sm:p-4">
        <Field
          label={en ? 'Local contact (relative, caretaker or staff)' : 'جهة اتصال محلية (قريب أو ناطور أو موظف)'}
          htmlFor="owner-localContactName"
          error={errors['contact.localContactName']}
        >
          <Input
            id="owner-localContactName"
            invalid={Boolean(errors['contact.localContactName'])}
            value={str(value.localContactName)}
            onChange={(e) => set({ localContactName: e.target.value })}
          />
        </Field>
        <Field
          label={en ? "Local contact's phone" : 'هاتف جهة الاتصال'}
          htmlFor="owner-localContactPhone"
          error={errors['contact.localContactPhone']}
        >
          <Input
            id="owner-localContactPhone"
            type="tel"
            inputMode="tel"
            dir="ltr"
            placeholder="03 123456"
            className="text-start"
            invalid={Boolean(errors['contact.localContactPhone'])}
            value={str(value.localContactPhone)}
            onChange={(e) => set({ localContactPhone: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}
