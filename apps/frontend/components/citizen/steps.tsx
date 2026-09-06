'use client';

import { useCallback, useEffect } from 'react';
import {
  BLOOD_TYPE,
  GENDER,
  getLabels,
  IDENTITY_DOC_TYPE,
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
      set({ identityDocType: 'PASSPORT' });
    }
  }, [isLebanese, value.nationality, value.residentStatus, value.identityDocType, locale, set]);

  const identityDocNumberLabel =
    labels.identityDocNumberLabel?.[value.identityDocType as never] ??
    (locale === 'en' ? 'Document Number' : 'رقم الوثيقة');

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

      {/* 4. ID Proof & Civil Record */}
      {isLebanese ? (
        <div className="space-y-3.5 rounded-lg border border-border/70 bg-muted/10 p-3 sm:p-4">
          <Field
            label={locale === 'en' ? 'ID Document Type' : 'نوع وثيقة الإثبات'}
            htmlFor="identityDocType"
            path="personal.identityDocType"
            required
            error={errors['personal.identityDocType']}
          >
            <SegmentedControl
              size="sm"
              value={str(value.identityDocType)}
              invalid={Boolean(errors['personal.identityDocType'])}
              onChange={(next) => set({ identityDocType: next })}
              options={IDENTITY_DOC_TYPE.map((o) => ({
                value: o,
                label: labels.identityDocType[o] ?? o,
              }))}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={identityDocNumberLabel}
              htmlFor="identityDocNumber"
              path="personal.identityDocNumber"
              required
              error={errors['personal.identityDocNumber']}
            >
              <Input
                id="identityDocNumber"
                inputMode="numeric"
                dir="ltr"
                placeholder="12345678"
                className="text-start"
                invalid={Boolean(errors['personal.identityDocNumber'])}
                value={str(value.identityDocNumber)}
                onChange={(e) => set({ identityDocNumber: e.target.value })}
              />
            </Field>

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
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-border/70 bg-muted/10 p-3 sm:p-4">
          <Field
            label={identityDocNumberLabel}
            htmlFor="identityDocNumber"
            path="personal.identityDocNumber"
            error={errors['personal.identityDocNumber']}
          >
            <Input
              id="identityDocNumber"
              inputMode="numeric"
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
        >
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            placeholder="03 123456"
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
              placeholder="70 123456"
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
          value={str(value.actualHouseholdMembers ?? value.familySize)}
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