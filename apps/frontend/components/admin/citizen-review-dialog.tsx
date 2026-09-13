'use client';

import { useMemo, useRef } from 'react';
import {
  Building2,
  CloudOff,
  FileQuestion,
  IdCard,
  Layers,
  Link2,
  ListChecks,
  Loader2,
  MapPin,
  Pencil,
  Save,
  StickyNote,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import { getLabels, PROPERTY_FIELD_MAP } from '@mechanization/shared-schemas';
import type { PropertyDraft, UnitDraft } from '@/components/citizen/property-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { CitizenFormValues } from './citizen-form';

/**
 * «مراجعة قبل الحفظ» — the whole record, read back, at the moment before it is
 * filed.
 *
 * ## Why a review exists again
 *
 * The citizen wizard had a `ReviewStep`, and it was dropped with the wizard on
 * the reasoning that a clerk "reviews the form itself rather than a summary of
 * it". That holds while the form is short. It stopped holding once one page
 * carried three sections, a branch per نوع الملف, a branch per نوع العقار and a
 * units editor — by the time an officer reaches «حفظ», البيانات الشخصية is
 * several screens behind them and the cards they filled first are folded shut.
 * The thing they cannot do is *see the record*.
 *
 * That is the gap this closes, and it is the only thing it does: it renders, it
 * never edits. Every correction leaves through «تعديل», back to the field that
 * is wrong, so there stays exactly one place any value can be changed.
 *
 * ## What it is answerable for
 *
 * **Every field the form asked, whether or not it was answered.** A review
 * listing only what was filled in cannot catch the thing worth catching — اسم
 * الأم never entered, a رقم العقار left blank on the third card. So each field
 * renders in one of three states, meant to be told apart at arm's length rather
 * than read:
 *
 *  - **filled** — a solid tile carrying the value at full weight;
 *  - **«غير مؤكَّد»** — an amber tile carrying the officer's own reason, because
 *    this is what will put the record at «يتطلب مراجعة»;
 *  - **«لم يُذكر»** — a dashed, quiet tile. Present, so its absence is visible;
 *    quiet, so twelve of them do not out-shout the values beside them.
 *
 * The branch rules are not restated here. Which fields a card carries comes
 * from `PROPERTY_FIELD_MAP` — the same constant `PropertyCard` renders from —
 * and the personal/contact branches key on the same three questions the steps
 * do (نوع الملف, الجنسية, واتساب نفس الرقم). A field this panel decided about on
 * its own would be a third copy of rules that already live in two places.
 *
 * ## What it deliberately does not do
 *
 * It is not shown before «حفظ سريع». That path exists for a visit that produced
 * almost nothing, it already confirms with a reason of its own, and a second
 * panel reading «لم يُذكر» twenty times is not a review — it is the thing the
 * officer has just finished telling us.
 */
export function CitizenReviewDialog({
  open,
  onOpenChange,
  values,
  mode,
  submitting,
  error,
  offline = false,
  onConfirm,
  onEditSection,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  values: CitizenFormValues;
  mode: 'create' | 'edit';
  submitting: boolean;
  /** The server's refusal, shown in the footer — the panel stays open on one. */
  error: string | null;
  offline?: boolean;
  onConfirm: () => void;
  /**
   * «تعديل» — close, and put the officer back in the section that is wrong.
   *
   * A review whose only exit is a general «عودة» makes them find the field
   * again themselves, which on a three-section page with folded cards is most
   * of the cost of the correction.
   */
  onEditSection: (section: 'personal' | 'contact' | 'properties' | 'notes') => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = useMemo(() => getLabels(locale), [locale]);
  const model = useMemo(() => buildReview(values, labels, en), [values, labels, en]);

  /**
   * The scrolling record, so opening the panel can put focus here.
   *
   * Left to itself Radix focuses the first tabbable descendant, which is the
   * first section's «تعديل» — so a keyboard user arrives on the control that
   * throws the panel away, and Enter sends them straight back to the form they
   * asked to review. Focusing the region instead means the panel starts where
   * it should (at the top of the record, scrollable by arrow key) and Tab walks
   * forward from there. Confirm is deliberately *not* focused: two Enters in a
   * row would then file the record without it having been looked at, which is
   * the one outcome this whole panel exists to prevent.
   */
  const recordRef = useRef<HTMLDivElement | null>(null);

  const statusLabel =
    model.flagCount > 0
      ? labels.citizenRecordStatus.REQUIRES_REVIEW
      : labels.citizenRecordStatus.PENDING;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={en ? 'Close' : 'إغلاق'}
        /*
          A panel rather than the default centred box: `p-0` and a flex column,
          so the identity header and the actions stay put while the record
          scrolls between them. `overflow-hidden` replaces the base
          `overflow-y-auto` — with both, the outer box scrolls and the header
          the officer is checking the name against scrolls away with it.

          `sm:p-0` is not redundant with `p-0`: the base carries its own
          `sm:p-6`, and tailwind-merge resolves conflicts per breakpoint, so an
          unqualified `p-0` leaves 24px of padding on every screen ≥640px —
          which is where the edge-to-edge header and footer stop meeting the
          panel's edges.
        */
        className="flex max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          recordRef.current?.focus();
        }}
      >
        {/* ── Who this record is about ── */}
        <header className="shrink-0 border-b border-border/70 bg-card px-4 pb-3.5 pe-12 pt-4 sm:px-6 sm:pe-14 sm:pt-5">
          <DialogTitle className="block text-base">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <ListChecks className="size-3.5 shrink-0" aria-hidden />
              {en ? 'Review before saving' : 'مراجعة قبل الحفظ'}
            </span>
            <span className="mt-1.5 block text-xl font-bold leading-tight tracking-tight text-foreground sm:text-2xl">
              {model.fullName || (
                <span className="text-muted-foreground">
                  {en ? 'Record with no name' : 'سجل بلا اسم'}
                </span>
              )}
            </span>
          </DialogTitle>

          <DialogDescription className="sr-only">
            {en
              ? 'Every field this form asked, as it will be filed. Nothing is editable here.'
              : 'كل ما سأل عنه هذا النموذج كما سيُحفظ. لا يمكن التعديل من هنا.'}
          </DialogDescription>

          {model.identityChips.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {model.identityChips.map((chip) => (
                <Badge key={chip.text} variant={chip.variant} className="font-medium">
                  {chip.text}
                </Badge>
              ))}
            </div>
          ) : null}
        </header>

        {/* ── The record ── */}
        <div
          ref={recordRef}
          tabIndex={-1}
          className="min-h-0 flex-1 space-y-3.5 overflow-y-auto bg-muted/20 px-3 py-3.5 outline-none sm:space-y-4 sm:px-5 sm:py-5"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CountTile
              value={model.filledCount}
              label={en ? 'Filled in' : 'حقل مُعبأ'}
              tone="primary"
            />
            <CountTile
              value={model.flagCount}
              label={en ? 'Unverified' : 'غير مؤكَّد'}
              tone={model.flagCount > 0 ? 'warning' : 'muted'}
            />
            <CountTile
              value={model.emptyCount}
              label={en ? 'Not recorded' : 'لم يُذكر'}
              tone="muted"
            />
            <CountTile
              value={values.properties.length}
              label={en ? 'Properties' : 'عقارات'}
              tone="muted"
            />
          </div>

          {/* What the record will say about itself once it is filed. */}
          <p
            className={cn(
              'flex items-start gap-2 rounded-xl border px-3.5 py-3 text-xs leading-relaxed sm:text-sm',
              model.flagCount > 0
                ? 'border-warning/40 bg-warning/10 text-warning'
                : 'border-success/40 bg-success/10 text-success',
            )}
          >
            {model.flagCount > 0 ? (
              <FileQuestion className="mt-px size-4 shrink-0" aria-hidden />
            ) : (
              <ListChecks className="mt-px size-4 shrink-0" aria-hidden />
            )}
            <span>
              {model.flagCount > 0
                ? en
                  ? `${model.flagCount} field(s) are marked unverified, with the reasons you gave. The record will be filed as «${statusLabel}».`
                  : `تم وسم ${model.flagCount} خانة بأنها غير مؤكَّدة مع الأسباب التي ذكرتها. سيُحفظ السجل بحالة «${statusLabel}».`
                : en
                  ? `No field was left unverified. The record will be filed as «${statusLabel}».`
                  : `لا توجد خانات غير مؤكَّدة. سيُحفظ السجل بحالة «${statusLabel}».`}
            </span>
          </p>

          {model.sections.map((section) => (
            <ReviewSectionCard
              key={section.id}
              section={section}
              values={values}
              en={en}
              onEdit={() => onEditSection(section.id)}
            />
          ))}

          {/* ── العقارات ── */}
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xs">
            <SectionHeader
              icon={Building2}
              title={
                en
                  ? `Properties (${values.properties.length})`
                  : `العقارات (${values.properties.length})`
              }
              onEdit={() => onEditSection('properties')}
              en={en}
            />

            {values.properties.length === 0 ? (
              <p className="m-3 rounded-xl border border-dashed border-border/70 bg-muted/25 px-3.5 py-4 text-center text-sm text-muted-foreground sm:m-4">
                {en
                  ? 'No property filed — this person owns nothing and only rents.'
                  : 'لا عقار في هذا السجل — لا يملك المواطن شيئاً ويستأجر فقط.'}
              </p>
            ) : (
              <div className="space-y-3 p-3 sm:p-4">
                {values.properties.map((property, index) => (
                  <PropertyReviewCard
                    key={property.id ?? index}
                    property={property}
                    index={index}
                    values={values}
                    labels={labels}
                    en={en}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── ملاحظات — only when there is one. A blank optional box is not a
                finding, and an empty tile here would read as one. ── */}
          {model.notes || model.blanketReason ? (
            <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xs">
              <SectionHeader
                icon={StickyNote}
                title={en ? 'Notes' : 'ملاحظات'}
                onEdit={() => onEditSection('notes')}
                en={en}
              />
              <div className="space-y-2.5 p-3 sm:p-4">
                {model.notes ? (
                  <p className="whitespace-pre-wrap rounded-xl border border-border/70 bg-background/60 px-3.5 py-3 text-[15px] leading-relaxed text-foreground">
                    {model.notes}
                  </p>
                ) : null}
                {model.blanketReason ? (
                  <div className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3">
                    <p className="text-xs font-medium text-warning">
                      {en ? 'Reason copied onto every gap' : 'سبب يُنسخ على كل حقل ناقص'}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                      {model.blanketReason}
                    </p>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        {/* ── Actions ── */}
        <footer className="shrink-0 space-y-2.5 border-t border-border/70 bg-card px-4 py-3 sm:px-6">
          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{error}</span>
            </p>
          ) : null}

          {/*
            `flex-col`, not the `flex-col-reverse` `DialogFooter` uses. That one
            reverses a cancel/confirm pair so confirm lands on top; this row is
            a hint and a pair, and reversing it would put both buttons above the
            sentence and away from the bottom edge — which on a phone is the
            half of the screen a thumb actually reaches.
          */}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {offline ? <CloudOff className="size-3.5 shrink-0 text-warning" aria-hidden /> : null}
              <span>
                {offline
                  ? en
                    ? 'Offline — stored on this device and sent when the network returns'
                    : 'بدون اتصال — يُحفظ على هذا الجهاز ويُرسل عند عودة الشبكة'
                  : en
                    ? 'Nothing here can be edited — use «Edit» on a section.'
                    : 'لا يمكن التعديل من هنا — استخدم «تعديل» على القسم.'}
              </span>
            </p>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
                className="h-11 flex-1 px-4 text-sm font-medium sm:h-10 sm:flex-none"
              >
                <Pencil className="size-3.5" aria-hidden />
                {en ? 'Back to editing' : 'عودة للتعديل'}
              </Button>
              <Button
                onClick={onConfirm}
                disabled={submitting}
                className="h-11 flex-1 gap-1.5 px-5 text-sm font-semibold sm:h-10 sm:flex-none"
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : offline ? (
                  <CloudOff className="size-4" aria-hidden />
                ) : (
                  <Save className="size-4" aria-hidden />
                )}
                {offline
                  ? en
                    ? 'Confirm & save on device'
                    : 'تأكيد والحفظ على الجهاز'
                  : mode === 'edit'
                    ? en
                      ? 'Confirm & save changes'
                      : 'تأكيد وحفظ التعديلات'
                    : en
                      ? 'Confirm & create'
                      : 'تأكيد وإنشاء السجل'}
              </Button>
            </div>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────  the review model  ──────────────────────────── */

type Labels = ReturnType<typeof getLabels>;

/** One field as the review renders it. */
interface ReviewRow {
  /**
   * The field's dot-path — the same key `values.flags` and `values.unverified`
   * are addressed by, which is what lets a tile find its own «غير مؤكَّد» reason
   * without either list being walked once per field.
   */
  path: string;
  label: string;
  /** The value, already in the officer's language. Absent means an empty box. */
  value?: string;
  /** Secondary facts hanging off the value — a landlord link, shared rights. */
  chips?: string[];
  /**
   * A number or a document reference, which BiDi must not reorder into the
   * Arabic line around it. Rendered inside `<bdi>`.
   */
  isolate?: boolean;
  /** Long values — a tent's location, a status sentence — take the full width. */
  wide?: boolean;
}

interface ReviewSection {
  id: 'personal' | 'contact';
  icon: typeof IdCard;
  title: string;
  rows: ReviewRow[];
}

/** Filled means "the officer put something here" — chips count. */
function isFilled(row: ReviewRow): boolean {
  return row.value !== undefined || (row.chips?.length ?? 0) > 0;
}

/** A trimmed string, or nothing — the same emptiness the server's `isAbsent` means. */
function text(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * An enum value in the officer's language.
 *
 * Falls back to the raw value rather than to nothing: a record carrying a code
 * this build has no label for still has a value in it, and rendering that as an
 * empty box — inside the panel whose whole job is catching empty boxes — is the
 * one failure this component cannot afford.
 */
function pick(map: Record<string, string>, value: unknown): string | undefined {
  const key = text(value);
  if (!key) return undefined;
  return map[key] ?? key;
}

function buildReview(values: CitizenFormValues, labels: Labels, en: boolean) {
  const nonResident = values.residence === 'NON_RESIDENT_OWNER';

  const sections: ReviewSection[] = [
    {
      id: 'personal',
      icon: IdCard,
      title: nonResident
        ? en
          ? 'Basic details'
          : 'البيانات الأساسية'
        : en
          ? 'Personal Info'
          : 'البيانات الشخصية',
      rows: withOrphanFlags(personalRows(values, labels, en), 'personal', values, labels),
    },
    {
      id: 'contact',
      icon: UsersRound,
      title: nonResident
        ? en
          ? 'Contact'
          : 'التواصل'
        : en
          ? 'Contact & Family'
          : 'التواصل والأسرة',
      rows: withOrphanFlags(contactRows(values, labels, en), 'contact', values, labels),
    },
  ];

  const propertyRowLists = values.properties.map((property, index) =>
    withOrphanFlags(
      propertyRows(property, index, labels, en),
      `properties.${index}`,
      values,
      labels,
    ),
  );

  const everyRow = [...sections.flatMap((section) => section.rows), ...propertyRowLists.flat()];

  return {
    sections,
    fullName: fullNameOf(values),
    identityChips: identityChips(values, labels, en),
    filledCount: everyRow.filter(isFilled).length,
    flagCount: values.flags.size,
    // Counted off the rows rather than off `askableFields`, so the number in
    // the tile and the dashed tiles on screen can never disagree.
    emptyCount: everyRow.filter((row) => !isFilled(row) && !values.flags.has(row.path)).length,
    notes: text(values.notes),
    blanketReason: text(values.blanketFlagReason),
  };
}

/** «حسن محمد نصرالله» — the three name boxes as the person is actually called. */
function fullNameOf(values: CitizenFormValues): string {
  return [
    text(values.personal.firstName),
    text(values.personal.middleName),
    text(values.personal.lastName),
  ]
    .filter(Boolean)
    .join(' ');
}

type ChipVariant = 'soft-default' | 'soft-muted' | 'soft-info';

/**
 * The handful of facts that decide what kind of record this is, as pills under
 * the name — نوع الملف first, because every branch below it follows from that
 * one answer, and it is the one an officer can pick wrongly without noticing.
 */
function identityChips(
  values: CitizenFormValues,
  labels: Labels,
  en: boolean,
): { text: string; variant: ChipVariant }[] {
  const residence = values.residence ?? 'RESIDENT';
  const chips: { text: string; variant: ChipVariant }[] = [
    { text: labels.citizenResidence[residence], variant: 'soft-default' },
  ];

  if (residence === 'NON_RESIDENT_OWNER') {
    const place = text(values.personal.residencePlace);
    if (place) {
      chips.push({ text: en ? `Lives in ${place}` : `يقيم في ${place}`, variant: 'soft-info' });
    }
    return chips;
  }

  const lebanese = values.personal.isLebanese !== false;
  chips.push({
    text: lebanese
      ? en
        ? 'Lebanese'
        : 'لبناني'
      : (text(values.personal.nationality) ?? (en ? 'Non-Lebanese' : 'غير لبناني')),
    variant: 'soft-info',
  });

  const status = pick(labels.residentStatus, values.personal.residentStatus);
  if (status) chips.push({ text: status, variant: 'soft-muted' });

  const gender = pick(labels.gender, values.personal.gender);
  if (gender) chips.push({ text: gender, variant: 'soft-muted' });

  return chips;
}

function personalRows(values: CitizenFormValues, labels: Labels, en: boolean): ReviewRow[] {
  const personal = values.personal;
  const field = labels.citizenField;

  // «غير مقيم في البلدة» asks four things and nothing a household file asks.
  if (values.residence === 'NON_RESIDENT_OWNER') {
    return [
      { path: 'personal.firstName', label: field.firstName, value: text(personal.firstName) },
      { path: 'personal.middleName', label: field.middleName, value: text(personal.middleName) },
      { path: 'personal.lastName', label: field.lastName, value: text(personal.lastName) },
      {
        path: 'personal.residencePlace',
        label: en ? 'Where they live' : 'مكان الإقامة',
        value: text(personal.residencePlace),
        wide: true,
      },
    ];
  }

  const lebanese = personal.isLebanese !== false;

  const rows: ReviewRow[] = [
    { path: 'personal.firstName', label: field.firstName, value: text(personal.firstName) },
    { path: 'personal.middleName', label: field.middleName, value: text(personal.middleName) },
    { path: 'personal.lastName', label: field.lastName, value: text(personal.lastName) },
    { path: 'personal.motherName', label: field.motherName, value: text(personal.motherName) },
    {
      /*
        Not flaggable, and never empty — it is a segmented control with a
        default. It is here because it is the switch every row below it hangs
        off, and a review that hides it cannot explain why رقم السجل is absent.
      */
      path: 'personal.isLebanese',
      label: en ? 'Nationality' : 'الجنسية',
      value: lebanese ? (en ? 'Lebanese' : 'لبناني') : en ? 'Non-Lebanese' : 'غير لبناني',
    },
    { path: 'personal.gender', label: field.gender, value: pick(labels.gender, personal.gender) },
    {
      path: 'personal.residentStatus',
      label: field.residentStatus,
      value: pick(labels.residentStatus, personal.residentStatus),
    },
  ];

  if (lebanese) {
    rows.push({
      path: 'personal.civilRecordNumber',
      label: en ? 'Civil Record (Sijil) No.' : 'رقم السجل (القيد)',
      value: text(personal.civilRecordNumber),
      isolate: true,
    });
  } else {
    rows.push(
      {
        path: 'personal.nationality',
        label: en ? 'Specific Nationality' : 'الجنسية بالتفصيل',
        value: text(personal.nationality),
      },
      {
        /*
          The form asks a non-Lebanese person for a passport specifically, so
          the panel names it the way the box did rather than reaching for the
          generic «رقم وثيقة الإثبات» the flag list carries.
        */
        path: 'personal.identityDocNumber',
        label: en ? 'Passport No.' : 'رقم جواز السفر',
        value: text(personal.identityDocNumber),
        isolate: true,
      },
      {
        path: 'personal.residencyNumber',
        label: en ? 'Residency Permit No.' : 'رقم الإقامة',
        value: text(personal.residencyNumber),
        isolate: true,
      },
    );
  }

  rows.push({
    path: 'personal.bloodType',
    label: field.bloodType,
    value: pick(labels.bloodType, personal.bloodType),
  });

  return rows;
}

function contactRows(values: CitizenFormValues, labels: Labels, en: boolean): ReviewRow[] {
  const contact = values.contact;
  const field = labels.citizenField;
  const phone = text(contact.phone);

  /*
    واتساب, when it is the same number.

    Shown as the phone again rather than as a blank with a note, because the
    question being answered here is "what number reaches this household on
    WhatsApp" — and «لم يُذكر» under it would be false.
  */
  const whatsapp: ReviewRow =
    contact.whatsappSameAsPhone === false
      ? {
          path: 'contact.whatsapp',
          label: field.whatsapp,
          value: text(contact.whatsapp),
          isolate: true,
        }
      : {
          path: 'contact.whatsapp',
          label: field.whatsapp,
          value: phone,
          isolate: true,
          chips: phone ? [en ? 'Same as primary phone' : 'نفس رقم الهاتف الأساسي'] : undefined,
        };

  if (values.residence === 'NON_RESIDENT_OWNER') {
    return [
      { path: 'contact.phone', label: field.phone, value: phone, isolate: true },
      whatsapp,
      {
        path: 'contact.localContactName',
        label: en ? 'Local contact' : 'جهة اتصال محلية',
        value: text(contact.localContactName),
      },
      {
        path: 'contact.localContactPhone',
        label: en ? "Local contact's phone" : 'هاتف جهة الاتصال المحلية',
        value: text(contact.localContactPhone),
        isolate: true,
      },
    ];
  }

  return [
    { path: 'contact.phone', label: field.phone, value: phone, isolate: true },
    whatsapp,
    {
      path: 'contact.maritalStatus',
      label: field.maritalStatus,
      value: pick(labels.maritalStatus, contact.maritalStatus),
    },
    {
      /*
        `totalRegisteredMembers` is deliberately not a second tile.

        The form stopped asking for it and now mirrors this same number into
        it. Two identical tiles under two different labels would read as two
        headcounts that happen to agree, which is not what the record says.
      */
      path: 'contact.actualHouseholdMembers',
      label: en
        ? 'Family members living in the house (excl. married)'
        : 'عدد أفراد الأسرة المقيمين في المنزل (دون المتزوجين)',
      value: text(contact.actualHouseholdMembers),
      isolate: true,
      wide: true,
    },
  ];
}

/**
 * One property card's fields, in the order the card asks them.
 *
 * Driven by `PROPERTY_FIELD_MAP` for the same reason `askableFields` is: a خيمة
 * shows three boxes and a مبنى four, and a panel holding its own opinion about
 * that is a third place to update when a branch changes — the one nobody would
 * think to check.
 */
function propertyRows(
  property: PropertyDraft,
  index: number,
  labels: Labels,
  en: boolean,
): ReviewRow[] {
  const field = labels.citizenField;
  const at = (name: string) => `properties.${index}.${name}`;
  const branch = PROPERTY_FIELD_MAP[property.propertyType as keyof typeof PROPERTY_FIELD_MAP] ?? [];
  const rows: ReviewRow[] = [];

  for (const name of branch) {
    switch (name) {
      case 'units':
        // Rendered as its own block below the grid — a unit is several fields.
        break;
      case 'neighborhood':
        rows.push({ path: at(name), label: field.neighborhood, value: text(property.neighborhood) });
        break;
      case 'propertyNumber':
        rows.push({
          path: at(name),
          label: field.propertyNumber,
          value: text(property.propertyNumber),
          isolate: true,
        });
        break;
      case 'buildingName':
        rows.push({
          path: at(name),
          label:
            property.propertyType === 'HOUSE'
              ? en
                ? 'Building / house name'
                : 'اسم المبنى/المنزل'
              : field.buildingName,
          value: text(property.buildingName),
        });
        break;
      case 'side':
        rows.push({ path: at(name), label: field.side, value: text(property.side) });
        break;
      case 'landType':
        rows.push({
          path: at(name),
          label: field.landType,
          value: pick(labels.landType, property.landType),
        });
        break;
      case 'tentLocation':
        rows.push({
          path: at(name),
          label: field.tentLocation,
          value: text(property.tentLocation),
          wide: true,
        });
        break;
      case 'unitArea': {
        const area = text(property.unitArea);
        rows.push({
          path: at(name),
          label: field.unitArea,
          value: area ? `${area} ${en ? 'm²' : 'م²'}` : undefined,
          isolate: true,
        });
        break;
      }
      case 'shares': {
        /*
          أسهم are a share of *ownership*. The card hides the box for a tenant
          or a شاغل بتسامح, so the panel must not stand a dashed «لم يُذكر» tile
          under a question that was never put — the same rule
          `propertyAskableFields` applies to the flag list.
        */
        if (property.occupancyType !== 'OWNER') break;
        const shares = text(property.shares);
        rows.push({
          path: at(name),
          label: en ? 'Shares (out of 2400)' : 'الأسهم (من أصل 2400)',
          value: shares ? `${shares} / 2400` : undefined,
          isolate: true,
        });
        break;
      }
      case 'sharedRights':
        rows.push({
          path: at(name),
          label: field.sharedRights,
          chips: property.sharedRights?.length ? property.sharedRights : undefined,
          wide: true,
        });
        break;
    }
  }

  /*
    The landlord block — put to a مستأجر and a شاغل بتسامح, to nobody else.

    `landlordCitizenId` is not a tile of its own: it answers "is this landlord
    somebody we already hold a file on", which belongs on the name it qualifies
    rather than as a bare id in its own box.
  */
  if (property.occupancyType === 'TENANT' || property.occupancyType === 'FREE_OCCUPANT') {
    rows.push({
      path: at('landlordName'),
      label: field.landlordName,
      value: text(property.landlordName),
      chips: property.landlordCitizenId
        ? [en ? 'Linked to a registered citizen' : 'مرتبط بملف مواطن مسجَّل']
        : undefined,
    });
    rows.push({
      path: at('landlordPhone'),
      label: field.landlordPhone,
      value: text(property.landlordPhone),
      isolate: true,
    });
  }

  /*
    حالة الوحدة / حالة الأرض — asked of an owner only, and only for a منزل or an
    أرض. A مبنى answers it per unit; a خيمة is never asked. Mirrors the two
    `UnitStatusChoice` branches on the card exactly.
  */
  if (
    property.occupancyType === 'OWNER' &&
    (property.propertyType === 'HOUSE' || property.propertyType === 'LAND')
  ) {
    rows.push({
      path: at('unitStatus'),
      label:
        property.propertyType === 'LAND' ? (en ? 'Land status' : 'حالة الأرض') : field.unitStatus,
      value: pick(labels.unitStatus, property.unitStatus),
      wide: true,
    });
  }

  return rows;
}

/**
 * Any «غير مؤكَّد» flag this panel drew no tile for, added as one.
 *
 * A flag is what puts the record at «يتطلب مراجعة», so the one thing a review
 * may never do is lose one. The two lists can legitimately differ — the flag
 * manager offers `contact.totalRegisteredMembers`, which the form stopped
 * asking for and this panel therefore does not show — and the honest answer to
 * that mismatch is a tile, not a quietly shorter list.
 */
function withOrphanFlags(
  rows: ReviewRow[],
  prefix: string,
  values: CitizenFormValues,
  labels: Labels,
): ReviewRow[] {
  const drawn = new Set(rows.map((row) => row.path));
  const orphans: ReviewRow[] = [];

  for (const path of values.flags.keys()) {
    if (drawn.has(path)) continue;
    if (!path.startsWith(`${prefix}.`)) continue;
    /*
      A property's own flags only — never a unit's.

      `properties.0.units.1.floor` starts with `properties.0.` too, and adding
      it here would put a tile labelled «الطابق» beside the card's own fields
      with nothing saying which flat it belongs to.
    */
    if (prefix.startsWith('properties.') && path.slice(prefix.length + 1).includes('.')) continue;
    const leaf = path.split('.').at(-1) ?? path;
    orphans.push({ path, label: labels.citizenField[leaf] ?? leaf });
  }

  return orphans.length > 0 ? [...rows, ...orphans] : rows;
}

/* ──────────────────────────────  rendering  ────────────────────────────── */

function CountTile({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: 'primary' | 'warning' | 'muted';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5 text-center',
        tone === 'primary' && 'border-primary/30 bg-primary/5',
        tone === 'warning' && 'border-warning/40 bg-warning/10',
        tone === 'muted' && 'border-border/70 bg-card',
      )}
    >
      <p
        className={cn(
          'text-2xl font-bold leading-none tabular-nums',
          tone === 'primary' && 'text-primary',
          tone === 'warning' && 'text-warning',
          tone === 'muted' && 'text-foreground',
        )}
      >
        {value}
      </p>
      <p className="mt-1.5 text-xs font-medium leading-tight text-muted-foreground">{label}</p>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  onEdit,
  en,
}: {
  icon: typeof IdCard;
  title: string;
  onEdit: () => void;
  en: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border/60 bg-muted/25 px-3 py-2.5 sm:px-4">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20"
      >
        <Icon className="size-4" />
      </span>
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      <Button
        variant="ghost"
        size="sm"
        onClick={onEdit}
        // 40px on a phone, matching the form's own mobile action bar, rather
        // than the 32px a ghost button beside a heading would usually take.
        // This is the panel's only way out to a correction — it is not chrome.
        className="h-10 shrink-0 gap-1 px-3 text-xs font-medium text-muted-foreground hover:text-foreground sm:h-8 sm:px-2.5"
      >
        <Pencil className="size-3.5" aria-hidden />
        {en ? 'Edit' : 'تعديل'}
      </Button>
    </div>
  );
}

function ReviewSectionCard({
  section,
  values,
  en,
  onEdit,
}: {
  section: ReviewSection;
  values: CitizenFormValues;
  en: boolean;
  onEdit: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xs">
      <SectionHeader icon={section.icon} title={section.title} onEdit={onEdit} en={en} />
      <FieldGrid rows={section.rows} values={values} en={en} className="p-3 sm:p-4" />
    </section>
  );
}

function FieldGrid({
  rows,
  values,
  en,
  className,
}: {
  rows: ReviewRow[];
  values: CitizenFormValues;
  en: boolean;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-2.5 sm:grid-cols-2', className)}>
      {rows.map((row) => (
        <FieldTile
          key={row.path}
          row={row}
          flagged={values.flags.has(row.path)}
          flagReason={values.flags.get(row.path)}
          note={values.unverified.get(row.path)}
          en={en}
        />
      ))}
    </div>
  );
}

/**
 * One field, in one of three states.
 *
 * The state is carried by the tile itself — solid, amber, dashed — rather than
 * by a word inside it, because the question this panel answers is asked at a
 * glance: *is anything here wrong or missing*. Reading twenty labels to find
 * out is the review the form already offers.
 */
function FieldTile({
  row,
  flagged,
  flagReason,
  note,
  en,
}: {
  row: ReviewRow;
  flagged: boolean;
  flagReason?: string;
  note?: string;
  en: boolean;
}) {
  const filled = isFilled(row);

  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-3',
        flagged
          ? 'border-warning/40 bg-warning/10'
          : filled
            ? 'border-border/70 bg-background/60'
            : 'border-dashed border-border/70 bg-muted/20',
        row.wide && 'sm:col-span-2',
      )}
    >
      <p className="text-xs font-medium leading-snug text-muted-foreground">{row.label}</p>

      {row.value !== undefined ? (
        <p className="mt-1 break-words text-[15px] font-semibold leading-6 text-foreground">
          {/*
            `<bdi>` rather than `dir="ltr"` on the paragraph: a رقم العقار or a
            phone number keeps its own digit order without dragging the Arabic
            line it sits in over to the left.
          */}
          {row.isolate ? <bdi className="tabular-nums">{row.value}</bdi> : row.value}
        </p>
      ) : flagged ? (
        <p className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold leading-6 text-warning">
          <FileQuestion className="size-4 shrink-0" aria-hidden />
          {en ? 'Unverified' : 'غير مؤكَّد'}
        </p>
      ) : !filled ? (
        <p className="mt-1 text-[15px] font-medium leading-6 text-muted-foreground">
          {en ? 'Not recorded' : 'لم يُذكر'}
        </p>
      ) : null}

      {row.chips?.length ? (
        <div className={cn('flex flex-wrap gap-1.5', row.value !== undefined ? 'mt-2' : 'mt-1.5')}>
          {row.chips.map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      {flagReason ? (
        <p className="mt-2 border-t border-warning/25 pt-2 text-xs leading-relaxed text-warning">
          {flagReason}
        </p>
      ) : null}

      {/* The server's «بانتظار التحقق» note, repeated here because it is said on
          the field itself while the officer is looking at it. */}
      {note ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{note}</span>
        </p>
      ) : null}
    </div>
  );
}

/** One property card, headed by the three facts that identify it. */
function PropertyReviewCard({
  property,
  index,
  values,
  labels,
  en,
}: {
  property: PropertyDraft;
  index: number;
  values: CitizenFormValues;
  labels: Labels;
  en: boolean;
}) {
  const rows = useMemo(
    () =>
      withOrphanFlags(
        propertyRows(property, index, labels, en),
        `properties.${index}`,
        values,
        labels,
      ),
    [property, index, labels, en, values],
  );

  const propertyType = pick(labels.propertyType, property.propertyType);
  const occupancy = pick(labels.occupancyType, property.occupancyType);
  const propertyNumber = text(property.propertyNumber);

  return (
    <article className="overflow-hidden rounded-xl border border-border/70 bg-background/40">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/60 bg-muted/25 px-3.5 py-2.5">
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-bold tabular-nums text-primary">
          {en ? `#${index + 1}` : `العقار ${index + 1}`}
        </span>
        <span className="text-sm font-semibold text-foreground">
          {propertyType ?? (
            <span className="text-destructive">
              {en ? 'Property type not set' : 'نوع العقار غير محدَّد'}
            </span>
          )}
        </span>
        {propertyNumber ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <bdi className="tabular-nums">{propertyNumber}</bdi>
          </span>
        ) : null}
        <Badge
          variant={
            property.occupancyType === 'OWNER'
              ? 'soft-default'
              : property.occupancyType === 'TENANT'
                ? 'soft-info'
                : 'soft-warning'
          }
          className="ms-auto font-medium"
        >
          {occupancy ?? (en ? 'Occupancy not set' : 'نوع الإشغال غير محدَّد')}
        </Badge>
      </header>

      {/* How this card sits against the building census — a link made, a
          structure about to be created, or neither. */}
      {property.pendingBuilding || property.buildingId ? (
        <p className="flex items-center gap-1.5 border-b border-border/50 bg-primary/5 px-3.5 py-2 text-xs text-primary">
          <Link2 className="size-3.5 shrink-0" aria-hidden />
          {property.pendingBuilding
            ? en
              ? 'A new structure will be created on this parcel when you save'
              : 'ستُنشأ منشأة جديدة على هذا العقار عند الحفظ'
            : en
              ? 'Linked to the building census'
              : 'مرتبط بسجل المباني'}
        </p>
      ) : null}

      <FieldGrid rows={rows} values={values} en={en} className="p-3 sm:p-3.5" />

      {property.propertyType === 'BUILDING' ? (
        <UnitsReview
          units={property.units ?? []}
          flagged={values.flags.has(`properties.${index}.units`)}
          flagReason={values.flags.get(`properties.${index}.units`)}
          labels={labels}
          en={en}
        />
      ) : null}
    </article>
  );
}

/**
 * وحدات المبنى, one line each.
 *
 * A grid of tiles per unit would be six boxes times however many flats, which is
 * a screen of chrome for what a reader actually needs: نوع الوحدة, then whatever
 * tells this one apart from the one above it. So the type carries the line and
 * the rest follows it as separated facts.
 */
function UnitsReview({
  units,
  flagged,
  flagReason,
  labels,
  en,
}: {
  units: UnitDraft[];
  flagged: boolean;
  flagReason?: string;
  labels: Labels;
  en: boolean;
}) {
  return (
    <div className="border-t border-border/60 px-3 py-3 sm:px-3.5">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Layers className="size-3.5 shrink-0" aria-hidden />
        {en ? `Units in this building (${units.length})` : `وحدات المبنى (${units.length})`}
      </p>

      {flagged ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
            <FileQuestion className="size-4 shrink-0" aria-hidden />
            {en ? 'Unverified' : 'غير مؤكَّد'}
          </p>
          {flagReason ? (
            <p className="mt-1.5 text-xs leading-relaxed text-warning">{flagReason}</p>
          ) : null}
        </div>
      ) : units.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2.5 text-sm font-medium text-muted-foreground">
          {en ? 'No unit recorded' : 'لم تُسجَّل أي وحدة'}
        </p>
      ) : (
        <ul className="space-y-2">
          {units.map((unit, unitIndex) => (
            <UnitLine
              key={unit.unitId ?? unitIndex}
              unit={unit}
              index={unitIndex}
              labels={labels}
              en={en}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function UnitLine({
  unit,
  index,
  labels,
  en,
}: {
  unit: UnitDraft;
  index: number;
  labels: Labels;
  en: boolean;
}) {
  const floor = text(unit.floor);
  const side = text(unit.side);
  const area = text(unit.unitArea);
  const status = pick(labels.unitStatus, unit.unitStatus);

  const facts = [
    floor ? (en ? `Floor ${floor}` : `الطابق ${floor}`) : undefined,
    side ? (en ? `Side: ${side}` : `الجهة: ${side}`) : undefined,
    area ? `${area} ${en ? 'm²' : 'م²'}` : undefined,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <li className="rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-bold tabular-nums text-muted-foreground">
          {index + 1}
        </span>
        <span className="text-sm font-semibold text-foreground">
          {pick(labels.unitType, unit.unitType) ?? (
            <span className="font-medium text-muted-foreground">
              {en ? 'Type not recorded' : 'نوع الوحدة غير مذكور'}
            </span>
          )}
        </span>
        {facts.map((fact) => (
          <span key={fact} className="text-xs text-muted-foreground">
            <span aria-hidden className="me-1.5 text-muted-foreground/50">
              ·
            </span>
            <bdi>{fact}</bdi>
          </span>
        ))}
        {unit.unitId ? (
          <span className="flex items-center gap-1 text-xs text-primary">
            <Link2 className="size-3 shrink-0" aria-hidden />
            {en ? 'Linked to the census' : 'مرتبطة بالمسح'}
          </span>
        ) : null}
      </div>

      {status ? <p className="mt-1.5 text-xs font-medium text-foreground">{status}</p> : null}

      {unit.sharedRights?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {unit.sharedRights.map((right) => (
            <span
              key={right}
              className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            >
              {right}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}
