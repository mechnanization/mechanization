'use client';

import { useCallback, useEffect, type ReactNode } from 'react';
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
import { cn } from '@/lib/utils';

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

  /*
    Four rows on a wide screen, one field per line on a phone:

      1. الاسم الأول · اسم الأب · الشهرة — the name, read as it is written
      2. اسم الأم وشهرتها — its own line; it is one phrase of two words
      3. الجنسية · الجنس (and الجنسية بالتفصيل between them when not Lebanese)
      4. صفة الإقامة · رقم السجل · فئة الدم (passport and residency in place of
         رقم السجل for a non-Lebanese person)

    `items-start` on every row, so a field showing an error grows downwards
    without pulling its neighbours' inputs out of line.
  */
  return (
    <div className="review-body space-y-4 sm:space-y-5">
      {/* Row 1 — the name */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
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

      {/*
        1b. اسم الأم وشهرتها — what tells two people with the same three names apart.

        Asked because the identity document is not. Officers were told the
        document was optional and filled it with shared or invented numbers, and
        since citizens were matched on it every repeated number merged distinct
        people; it was removed on 2026-09-13 and left the register with three
        name parts, a phone a household shares, and a رقم سجل shared by everyone
        on the same قيد. This is what the ID card and the قيد carry for exactly
        this job, and the one identifying answer at a counter that nobody has a
        reason to invent.

        One field, not «اسم الأم» plus «شهرة الأم». The question is asked and
        answered as one phrase — and a married Lebanese woman is recorded in the
        قيد under her father's family name while being addressed by her
        husband's, so a second box would make a clerk who was told «فاطمة» guess
        at which surname is meant. That guess is the invention this whole change
        was about.

        Its own line, below the name row rather than in it: a four-column
        name grid is four cramped boxes, and this one holds two words.

        Required, and flaggable — which is the half that makes requiring it
        safe. An officer who does not know marks it «غير مؤكَّد» with a reason
        instead of typing something. It also renders blank on households filed
        before migration 0044, so editing an old record is where those gaps
        surface and get answered honestly.
      */}
      <Field
        label={locale === 'en' ? "Mother's Full Name" : 'اسم الأم وشهرتها'}
        htmlFor="motherName"
        path="personal.motherName"
        required
        error={errors['personal.motherName']}
      >
        <Input
          id="motherName"
          placeholder={locale === 'en' ? 'e.g. Fatima Khalil' : 'مثال: فاطمة خليل'}
          invalid={Boolean(errors['personal.motherName'])}
          value={str(value.motherName)}
          onChange={(e) => set({ motherName: e.target.value })}
        />
      </Field>

      {/* Row 3 — nationality and gender */}
      <div className={cn('grid grid-cols-1 items-start gap-3.5 sm:grid-cols-2', !isLebanese && 'lg:grid-cols-3')}>
        <Field
          label={locale === 'en' ? 'Nationality' : 'الجنسية'}
          htmlFor="isLebanese"
          path="personal.isLebanese"
          required
          error={errors['personal.isLebanese']}
        >
          <SegmentedControl
            size="field"
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

        <Field
          label={locale === 'en' ? 'Gender' : 'الجنس'}
          htmlFor="gender"
          path="personal.gender"
          required
          error={errors['personal.gender']}
        >
          <SegmentedControl
            size="field"
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

      {/* Row 4 — residency, the register number, blood type */}
      <div
        className={cn(
          'grid grid-cols-1 items-start gap-3.5 md:grid-cols-2',
          // Four across only where four fit: «من سكان الضيعة» is one of three
          // segments in صفة الإقامة, and a quarter of a laptop is not enough.
          isLebanese ? 'lg:grid-cols-3' : '2xl:grid-cols-4',
        )}
      >
        <Field
          label={locale === 'en' ? 'Residency Status' : 'صفة الإقامة'}
          htmlFor="residentStatus"
          path="personal.residentStatus"
          required
          error={errors['personal.residentStatus']}
        >
          <SegmentedControl
            size="field"
            value={str(value.residentStatus)}
            invalid={Boolean(errors['personal.residentStatus'])}
            onChange={(next) => set({ residentStatus: next })}
            options={residentStatusOptions.map((option) => ({
              value: option,
              label: labels.residentStatus[option] ?? option,
            }))}
          />
        </Field>

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
          <>
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
          </>
        ) : (
          <>
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
          </>
        )}

        {/*
          5. Blood Type — asked of everyone, demanded of nobody.

          A required box in front of a clerk who was told «ما بعرف» gets a
          plausible answer rather than an empty one, and a guessed «O+» on a
          household card is worse than a blank: the blank is the only one of the
          two a later visit can read as a question still open. See
          `personalDetailsObject.bloodType` for the rule this mirrors.
        */}
        <Field
          label={locale === 'en' ? 'Blood Type' : 'فئة الدم'}
          htmlFor="bloodType"
          path="personal.bloodType"
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
    </div>
  );
}

/** Step 2 — معلومات التواصل والأسرة */
export function ContactStep({
  value,
  errors,
  onChange,
  locale = 'ar',
  afterPhone,
}: {
  value: Values;
  errors: Errors;
  onChange: (next: Values) => void;
  locale?: string;
  /**
   * Rendered inside the phone card, directly under the numbers.
   *
   * A slot rather than a fixed element because what goes here is the admin
   * form's «قد يكون مسجَّلاً مسبقاً» panel, which reads the municipality's own
   * citizen list — the public wizard has no business showing a resident which
   * of their neighbours the register holds, and passes nothing.
   *
   * It belongs *here* and nowhere else: the panel's strongest signal is the
   * phone number, and it used to sit at the foot of the personal step — above
   * the field that produces most of its matches, in a different section of the
   * form. An officer met a warning about a number they had not typed yet.
   */
  afterPhone?: ReactNode;
}) {
  const labels = getLabels(locale);
  const set = (patch: Values) => onChange({ ...value, ...patch });
  const sameAsPhone = value.whatsappSameAsPhone !== false;
  const sameAsPhoneToggle = (
    <label
      htmlFor="whatsappSameAsPhone"
      className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <Checkbox
        id="whatsappSameAsPhone"
        checked={sameAsPhone}
        onCheckedChange={(checked) => set({ whatsappSameAsPhone: checked === true })}
      />
      <span className="whitespace-nowrap font-medium">
        {locale === 'en' ? 'Same as phone' : 'نفس رقم الهاتف'}
      </span>
    </label>
  );

  return (
    /*
      Two rows of two on a wide screen, one field per line on a phone:
      the two numbers, then the household. The duplicates panel sits between
      them — directly under the numbers, which is what most of its matches
      are made on (see `afterPhone`).
    */
    <div className="review-body space-y-4 sm:space-y-5">
      {/* Row 1 — the numbers */}
      <div className="review-body grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
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
            placeholder="03 123456 / +33 6 12 34 56 78"
            className="text-start"
            invalid={Boolean(errors['contact.phone'])}
            value={str(value.phone)}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>

        {/*
          A `Field` with its path once it is a number of its own, like the
          non-resident form's: `contact.whatsapp` is flaggable then, and a
          hand-built input was the one flaggable field that could not show its
          flag, and was absent from «خانات غير مؤكَّدة».

          «نفس رقم الهاتف» on the same line as the box, in both states — it is
          the switch between the two, so it belongs beside what it switches.
        */}
        {sameAsPhone ? (
          <div className="space-y-1.5">
            <Label htmlFor="whatsappSameAsPhone" className="text-xs font-medium text-foreground/90">
              {locale === 'en' ? 'WhatsApp Number' : 'رقم الواتساب'}
            </Label>
            <div className="flex items-center gap-3">
              <div className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-dashed border-border/80 bg-muted/20 px-3 text-xs text-muted-foreground coarse:h-12">
                <span className="truncate">
                  {locale === 'en' ? '✓ Using primary phone for WhatsApp' : '✓ يتم استخدام رقم الهاتف الأساسي للواتساب'}
                </span>
              </div>
              {sameAsPhoneToggle}
            </div>
          </div>
        ) : (
          <Field
            label={locale === 'en' ? 'WhatsApp Number' : 'رقم الواتساب'}
            htmlFor="whatsapp"
            path="contact.whatsapp"
            required
            error={errors['contact.whatsapp']}
          >
            <div className="flex items-center gap-3">
              <Input
                id="whatsapp"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                placeholder="70 123456 / +33 6 12 34 56 78"
                className="min-w-0 flex-1 text-start"
                invalid={Boolean(errors['contact.whatsapp'])}
                value={str(value.whatsapp)}
                onChange={(e) => set({ whatsapp: e.target.value })}
              />
              {sameAsPhoneToggle}
            </div>
          </Field>
        )}
      </div>

      {afterPhone}

      {/* Row 2 — the household */}
      <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
        <Field
          label={locale === 'en' ? 'Marital Status' : 'الحالة الاجتماعية'}
          htmlFor="maritalStatus"
          path="contact.maritalStatus"
          required
          error={errors['contact.maritalStatus']}
        >
          <SegmentedControl
            size="field"
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
            className="text-start"
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
    <div className="review-body space-y-4 sm:space-y-5">
      {/* The name on one line, as on a household file. */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
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
  afterPhone,
}: {
  value: Values;
  errors: Errors;
  onChange: (next: Values) => void;
  locale?: string;
  /** Under the numbers, as in `ContactStep` — see the note there. */
  afterPhone?: ReactNode;
}) {
  const en = locale === 'en';
  const set = (patch: Values) => onChange({ ...value, ...patch });
  const sameAsPhone = value.whatsappSameAsPhone !== false;

  return (
    <div className="review-body space-y-4 sm:space-y-5">
      {/* Row 1 — their own numbers */}
      <div className="review-body grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
        <div className="review-body space-y-2">
          <Field
            label={en ? 'Phone' : 'رقم الهاتف'}
            htmlFor="owner-phone"
            path="contact.phone"
            required
            error={errors['contact.phone']}
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
        </div>

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

      {afterPhone}

      {/* Row 2 — somebody local */}
      <div className="review-body grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
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
