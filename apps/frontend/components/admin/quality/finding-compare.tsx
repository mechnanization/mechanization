'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Loader2, Pencil, ShieldAlert } from 'lucide-react';
import {
  arabicOrLatinName,
  getLabels,
  internationalPhone,
  qualityLabels,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getBuilding,
  getCitizenForm,
  getCitizenProfile,
  logApiError,
  updateCitizen,
  type BuildingDetail,
  type CitizenFormData,
  type CitizenProfile,
} from '@/lib/api-client';
import {
  citizenFieldPatch,
  isEditableOn,
  type CitizenEditableField,
} from '@/lib/citizen-field-edit';
import type { FindingSubject, QualityFinding } from '@/lib/quality-api';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ChangeValue } from '@/components/ui/facts';
import { Input } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { comparablePairOf, FindingDetail, SeverityMark } from './finding-parts';

/**
 * «الإجراء» — the two records of a conflict, set against each other.
 *
 * ## What this screen is for
 *
 * A reviewer looking at «شخص مسجَّل مرتين» has one question: is this one person
 * filed twice, or two people who share a name and a household phone? Nothing in
 * a queue row answers it. Two files opened in two tabs answer it badly — the
 * fields are in the same order on both, but they are not on the same *line*, so
 * the comparison is done from memory, one field at a time.
 *
 * So both records are laid out on one grid: one row per fact, label at the
 * inline start, the two values on the same horizontal axis with a hairline
 * between them. A reader runs their eye down and the differences are where the
 * rows stop matching.
 *
 * ## What a red dot means, and what it deliberately does not
 *
 * A red dot marks a row where both records answer and the answers disagree —
 * that is a contradiction, and it is what decides the question.
 *
 * A row where one side answers and the other is blank gets a muted mark and the
 * words «لم يُسأل» instead. That distinction is not decoration: a household
 * filed before migration 0044 holds no اسم الأم at all, and painting that blank
 * red would report "these two disagree about the mother" when what actually
 * happened is that nobody was ever asked. The register has already been burned
 * once by treating an absence as a difference.
 *
 * ## Correcting from here
 *
 * The three fields a duplicate is decided on — الاسم، اسم الأم وشهرتها، الهاتف —
 * can be corrected in place, through the same `PATCH /citizens/:id` the edit
 * form posts to and with the same version check, so a save is refused if
 * somebody changed the file while this was open. Everything else on the record
 * is still edited where it always was, and the link to that file sits at the top
 * of each card.
 */

/** Both compare tables read from this shape, whatever kind of record they show. */
interface CompareRow {
  key: string;
  label: string;
  /** Rendered per side. The dot is drawn by the table, never by the caller. */
  cells: [React.ReactNode, React.ReactNode];
  /** What the two values do to each other. */
  state: 'conflict' | 'gap' | 'same';
}

/** «—» for a value the register does not hold, never an empty cell. */
function shown(value: unknown): { node: React.ReactNode; present: boolean } {
  if (value === null || value === undefined || value === '') {
    return { node: <span className="text-muted-foreground">—</span>, present: false };
  }
  return { node: <bdi>{String(value)}</bdi>, present: true };
}

/**
 * A plain pair of values, compared and rendered.
 *
 * `compare` is what two values are judged by — trimmed text by default, and a
 * caller passes something looser where the raw value is not the fact (a phone
 * written with spaces is the same phone).
 */
function row(
  key: string,
  label: string,
  a: unknown,
  b: unknown,
  compare: (value: unknown) => string = (value) => String(value ?? '').trim(),
): CompareRow {
  const left = shown(a);
  const right = shown(b);
  const state: CompareRow['state'] =
    !left.present || !right.present
      ? left.present === right.present
        ? 'same'
        : 'gap'
      : compare(a) === compare(b)
        ? 'same'
        : 'conflict';
  return { key, label, cells: [left.node, right.node], state };
}

/**
 * The grid itself: one label column and two value columns that line up.
 *
 * Below `sm` there is no room for three columns, so each row becomes a small
 * block — the label once, then the two values each under the short name of the
 * record it belongs to. The comparison survives a phone, which is what an
 * inspector standing in a street is holding.
 */
function CompareTable({
  headers,
  shortHeaders,
  rows,
  locale,
}: {
  headers: [React.ReactNode, React.ReactNode];
  shortHeaders: [string, string];
  rows: CompareRow[];
  locale: string;
}): React.JSX.Element {
  const en = locale === 'en';
  const columns = 'grid grid-cols-1 sm:grid-cols-[minmax(7rem,11rem)_1fr_1fr]';

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={cn(columns, 'border-b bg-muted/40')}>
        <div className="hidden px-4 py-3 sm:block" />
        <div className="px-4 py-3">{headers[0]}</div>
        <div className="border-t px-4 py-3 sm:border-t-0 sm:border-s">{headers[1]}</div>
      </div>

      <dl className="divide-y">
        {rows.map((entry) => (
          <div key={entry.key} className={cn(columns, 'text-sm')}>
            <dt className="bg-muted/20 px-4 py-2 text-xs text-muted-foreground sm:bg-transparent sm:py-2.5">
              {entry.label}
            </dt>
            {([0, 1] as const).map((side) => (
              <dd
                key={side}
                className={cn(
                  'px-4 py-2 sm:py-2.5',
                  side === 1 && 'border-t sm:border-t-0 sm:border-s',
                )}
              >
                <span className="flex min-w-0 items-start gap-2">
                  {/*
                    The mark, at the value's own inline start so the eye finds it
                    on the same edge every row — and carrying its meaning in
                    words for anyone the colour does not reach.
                  */}
                  {entry.state === 'conflict' ? (
                    <>
                      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive" />
                      <span className="sr-only">{en ? 'Differs: ' : 'قيمتان مختلفتان: '}</span>
                    </>
                  ) : entry.state === 'gap' ? (
                    <>
                      <span
                        aria-hidden
                        className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/40"
                      />
                      <span className="sr-only">{en ? 'Not asked on one record: ' : 'لم يُسأل في أحد السجلين: '}</span>
                    </>
                  ) : (
                    <span aria-hidden className="mt-1.5 size-2 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 break-words">
                    <span className="me-1.5 text-xs text-muted-foreground sm:hidden">
                      {shortHeaders[side]}:
                    </span>
                    {entry.cells[side]}
                  </span>
                </span>
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The card heading for one side: what the record is called, and its way in. */
function RecordHeading({
  title,
  secondary,
  href,
  openLabel,
}: {
  title: string;
  secondary: string | null;
  href: string;
  openLabel: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold">
        <bdi>{title}</bdi>
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        {secondary ? (
          <span className="text-muted-foreground">
            <bdi>{secondary}</bdi>
          </span>
        ) : null}
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
        >
          {openLabel}
          <ExternalLink className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

/** The screen's own chrome: back, what is being compared, and why. */
function CompareShell({
  finding,
  locale,
  onBack,
  children,
}: {
  finding: QualityFinding;
  locale: string;
  onBack: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const en = locale === 'en';
  const quality = qualityLabels(locale);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:text-sm"
          >
            <ArrowLeft className="size-3.5 rtl:rotate-180 sm:size-4" aria-hidden />
            {en ? 'Back to quality findings' : 'رجوع إلى ملاحظات الجودة'}
          </button>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {quality.findingKind[finding.kind] ?? finding.kind}
            <SeverityMark severity={finding.severity} locale={locale} />
          </h2>
          <FindingDetail detail={finding.detail} locale={locale} className="text-sm" />
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * How many rows disagree — said once, above the grid.
 *
 * Phrased as label-then-number rather than «٣ حقول مختلفة», which would need
 * Arabic's four plural forms to be right at 0, 1, 2 and 11. A legend reads the
 * same either way and cannot be wrong.
 */
function DifferenceSummary({ rows, locale }: { rows: CompareRow[]; locale: string }): React.JSX.Element {
  const en = locale === 'en';
  const conflicts = rows.filter((entry) => entry.state === 'conflict').length;
  const gaps = rows.filter((entry) => entry.state === 'gap').length;

  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2 rounded-full bg-destructive" />
        {en ? 'Fields that disagree:' : 'حقول متعارضة:'}
        <span className="font-medium tabular-nums text-foreground">{conflicts}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2 rounded-full border border-muted-foreground/40" />
        {en ? 'Asked on one record only:' : 'لم يُسأل في أحد السجلين:'}
        <span className="font-medium tabular-nums text-foreground">{gaps}</span>
      </span>
    </p>
  );
}

// ─────────────────────────────  Citizens  ─────────────────────────────

/** The rows of one name, as the three parts the register stores. */
const NAME_FIELDS: readonly CitizenEditableField[] = ['firstName', 'middleName', 'lastName'];

type EditableRow = 'name' | 'motherName' | 'phone';

const ROW_FIELDS: Record<EditableRow, readonly CitizenEditableField[]> = {
  name: NAME_FIELDS,
  motherName: ['motherName'],
  phone: ['phone'],
};

/** Whether a blank was deliberate — an officer's «غير مؤكَّد» on this very field. */
function isExcused(form: CitizenFormData, field: CitizenEditableField): boolean {
  return (form.flags ?? []).some((flag) => flag.path === `personal.${field}` || flag.path === `contact.${field}`);
}

/**
 * The one field's worth of validation this screen does before it asks the
 * server.
 *
 * The *same* schemas the form and the server use — not a second set of rules
 * that agree today. A name is `arabicOrLatinName`, a phone is
 * `internationalPhone`, and the parsed output is what gets sent, so «٧٠ ١٢٣ ٤٥٦»
 * is stored the way every other phone on the register is.
 */
function validateField(
  field: CitizenEditableField,
  value: string,
  form: CitizenFormData,
): { ok: true; value: string } | { ok: false; message: string } {
  const raw = value.trim();
  if (!raw) {
    // A blank an officer explicitly marked «غير مؤكَّد» is a legitimate state of
    // the record; a blank nobody accounted for is not one this screen creates.
    return isExcused(form, field)
      ? { ok: true, value: '' }
      : { ok: false, message: 'هذا الحقل مطلوب' };
  }
  const schema = field === 'phone' ? internationalPhone : arabicOrLatinName;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'قيمة غير صالحة' };
  }
  return { ok: true, value: parsed.data };
}

function citizenRows(
  a: CitizenProfile,
  b: CitizenProfile,
  locale: string,
): CompareRow[] {
  const labels = getLabels(locale);
  const en = locale === 'en';
  const field = labels.citizenField;
  // A phone is the same phone however it was typed.
  const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

  const household = (person: CitizenProfile) =>
    person.actualHouseholdMembers == null && person.totalRegisteredMembers == null
      ? null
      : `${person.actualHouseholdMembers ?? '—'} / ${person.totalRegisteredMembers ?? '—'}`;

  const properties = (person: CitizenProfile) =>
    person.registrations.reduce((total, registration) => total + registration.properties.length, 0);

  const enumValue = (map: Record<string, string>, value: string | null) =>
    value ? (map[value] ?? value) : null;

  return [
    row('name', en ? 'Full name' : 'الاسم الكامل', a.fullName, b.fullName),
    row('motherName', field.motherName, a.motherName, b.motherName),
    row('phone', field.phone, a.phone, b.phone, digits),
    row('whatsapp', field.whatsapp, a.whatsapp, b.whatsapp, digits),
    row('reference', en ? 'Reference number' : 'الرقم المرجعي', a.referenceNumber, b.referenceNumber),
    row('civilRecord', field.civilRecordNumber, a.civilRecordNumber, b.civilRecordNumber),
    row(
      'residence',
      en ? 'File type' : 'نوع الملف',
      enumValue(labels.citizenResidence as Record<string, string>, a.residence ?? null),
      enumValue(labels.citizenResidence as Record<string, string>, b.residence ?? null),
    ),
    row(
      'gender',
      field.gender,
      enumValue(labels.gender as Record<string, string>, a.gender),
      enumValue(labels.gender as Record<string, string>, b.gender),
    ),
    row('nationality', field.nationality, a.nationality, b.nationality),
    row(
      'residentStatus',
      field.residentStatus,
      enumValue(labels.residentStatus as Record<string, string>, a.residentStatus),
      enumValue(labels.residentStatus as Record<string, string>, b.residentStatus),
    ),
    row(
      'maritalStatus',
      field.maritalStatus,
      enumValue(labels.maritalStatus as Record<string, string>, a.maritalStatus),
      enumValue(labels.maritalStatus as Record<string, string>, b.maritalStatus),
    ),
    row(
      'household',
      en ? 'Household (living / registered)' : 'الأسرة (مقيمون / مسجّلون)',
      household(a),
      household(b),
    ),
    row('properties', en ? 'Properties on file' : 'عدد العقارات', properties(a), properties(b)),
    row(
      'registeredAt',
      en ? 'Filed on' : 'تاريخ التسجيل',
      formatDate(a.registeredAt),
      formatDate(b.registeredAt),
    ),
    row(
      'active',
      en ? 'Record state' : 'حالة السجل',
      a.isActive ? (en ? 'Active' : 'نشط') : en ? 'Deactivated' : 'موقوف',
      b.isActive ? (en ? 'Active' : 'نشط') : en ? 'Deactivated' : 'موقوف',
    ),
  ];
}

/** What is being changed, while the confirmation is on screen. */
interface PendingEdit {
  side: 0 | 1;
  citizenId: string;
  row: EditableRow;
  label: string;
  before: string;
  after: string;
  values: Partial<Record<CitizenEditableField, string>>;
}

function CitizenCompare({
  finding,
  pair,
  tenant,
  base,
  locale,
  token,
  canEdit,
  onBack,
  onChanged,
}: {
  finding: QualityFinding;
  pair: { a: FindingSubject; b: FindingSubject };
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  canEdit: boolean;
  onBack: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const toast = useToast();

  const query = useStaffQuery({
    queryKey: ['quality-compare-citizens', tenant, pair.a.id, pair.b.id],
    queryFn: (tok) =>
      Promise.all([
        getCitizenProfile(tenant, tok, pair.a.id),
        getCitizenProfile(tenant, tok, pair.b.id),
      ]),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the two records.' : 'تعذّر تحميل السجلّين.',
    keepPrevious: true,
  });

  /** The editable copy of each side, fetched only when somebody starts editing. */
  const [forms, setForms] = useState<Record<string, CitizenFormData>>({});
  const [loadingForm, setLoadingForm] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ side: 0 | 1; row: EditableRow } | null>(null);
  const [draft, setDraft] = useState<Partial<Record<CitizenEditableField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingEdit | null>(null);

  const cancelEdit = () => {
    setEditing(null);
    setDraft({});
    setProblem(null);
  };

  const startEdit = async (side: 0 | 1, citizenId: string, target: EditableRow) => {
    if (!token) return;
    setProblem(null);
    let form = forms[citizenId];
    if (!form) {
      setLoadingForm(citizenId);
      try {
        form = await getCitizenForm(tenant, token, citizenId);
        setForms((current) => ({ ...current, [citizenId]: form! }));
      } catch (caught) {
        logApiError(caught);
        toast.error(
          caught instanceof ApiRequestError
            ? caught.message
            : en
              ? 'Could not open this record for editing.'
              : 'تعذّر فتح هذا السجل للتعديل.',
        );
        return;
      } finally {
        setLoadingForm(null);
      }
    }
    const section = (field: CitizenEditableField) =>
      field === 'phone' ? form!.contact : form!.personal;
    setDraft(
      Object.fromEntries(
        ROW_FIELDS[target].map((field) => [field, String(section(field)[field] ?? '')]),
      ),
    );
    setEditing({ side, row: target });
  };

  /** Validates the draft and, if it holds, raises the confirmation. */
  const requestSave = (side: 0 | 1, person: CitizenProfile, target: EditableRow) => {
    const form = forms[person.id];
    if (!form) return;

    const values: Partial<Record<CitizenEditableField, string>> = {};
    for (const field of ROW_FIELDS[target]) {
      if (!isEditableOn(form, field)) continue;
      const checked = validateField(field, draft[field] ?? '', form);
      if (!checked.ok) {
        setProblem(`${labels.citizenField[field] ?? field}: ${checked.message}`);
        return;
      }
      values[field] = checked.value;
    }

    const before =
      target === 'name'
        ? person.fullName
        : target === 'motherName'
          ? (person.motherName ?? '—')
          : (person.phone ?? '—');
    const after =
      target === 'name'
        ? NAME_FIELDS.map((field) => values[field] ?? '')
            .filter(Boolean)
            .join(' ')
        : (values[target === 'motherName' ? 'motherName' : 'phone'] ?? '');

    if (before === after) {
      cancelEdit();
      return;
    }

    setProblem(null);
    setPending({
      side,
      citizenId: person.id,
      row: target,
      label:
        target === 'name'
          ? en
            ? 'Full name'
            : 'الاسم الكامل'
          : (labels.citizenField[target] ?? target),
      before,
      after,
      values,
    });
  };

  const save = async () => {
    if (!pending || !token) return;
    const form = forms[pending.citizenId];
    if (!form) return;

    await updateCitizen(tenant, token, pending.citizenId, citizenFieldPatch(form, pending.values));

    toast.success(en ? 'The record was corrected.' : 'صُحِّح السجل.');
    /*
      The saved file's version is now stale in `forms`, and so is every value on
      it. Dropped rather than patched: the next edit re-reads it, which is also
      what makes the version check meaningful instead of a token carried
      forward.
    */
    setForms((current) => {
      const next = { ...current };
      delete next[pending.citizenId];
      return next;
    });
    setPending(null);
    cancelEdit();
    query.refetch();
    // A corrected name or phone may dissolve the finding itself — the queue
    // behind this screen has to hear about it.
    onChanged();
  };

  if (query.error) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <ErrorState description={query.error} onRetry={query.refetch} />
      </CompareShell>
    );
  }

  if (query.loading || !query.data) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <LoadingState label={en ? 'Loading both records…' : 'جارٍ تحميل السجلّين…'} />
      </CompareShell>
    );
  }

  const people = query.data;
  const rows = citizenRows(people[0], people[1], locale);

  /** The edit control, or the inputs, for one editable row on one side. */
  const editCell = (side: 0 | 1, target: EditableRow): React.ReactNode => {
    const person = people[side];
    const form = forms[person.id];
    const open = editing?.side === side && editing.row === target;

    if (!canEdit) return null;

    /*
      A «غير مقيم في البلدة» file is never asked for اسم الأم — its form does not
      have the field. Said here rather than left as a missing button: one side of
      the comparison offering «تعديل» where the other does not reads as a fault
      until you know why.
    */
    if (target === 'motherName' && person.residence === 'NON_RESIDENT_OWNER') {
      return (
        <span className="mt-1 block text-xs text-muted-foreground">
          {en ? 'Not asked on a non-resident file.' : 'لا يُسأل في ملف «غير مقيم».'}
        </span>
      );
    }

    if (!open) {
      return (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          disabled={loadingForm === person.id}
          onClick={() => void startEdit(side, person.id, target)}
        >
          {loadingForm === person.id ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Pencil className="size-3" aria-hidden />
          )}
          {en ? 'Edit' : 'تعديل'}
        </Button>
      );
    }

    const fields = ROW_FIELDS[target].filter((field) => !form || isEditableOn(form, field));

    return (
      <div className="mt-1.5 space-y-2">
        {fields.map((field) => (
          <div key={field} className="space-y-1">
            <label htmlFor={`edit-${side}-${field}`} className="text-xs text-muted-foreground">
              {labels.citizenField[field] ?? field}
            </label>
            <Input
              id={`edit-${side}-${field}`}
              value={draft[field] ?? ''}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field]: event.target.value }))
              }
              dir={field === 'phone' ? 'ltr' : undefined}
              maxLength={60}
              className="h-9"
            />
          </div>
        ))}
        {problem ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" className="h-8" onClick={() => requestSave(side, person, target)}>
            {en ? 'Save' : 'حفظ'}
          </Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={cancelEdit}>
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
        </div>
      </div>
    );
  };

  /*
    The three anchor rows carry their own control. They are the fields every
    registration is keyed on — الاسم، اسم الأم وشهرتها، الهاتف — which is exactly
    why they are the ones worth correcting from a comparison: a duplicate is
    decided on them, and so is the correction that dissolves it.
  */
  const withEditing = rows.map((entry) => {
    const target: EditableRow | null =
      entry.key === 'name'
        ? 'name'
        : entry.key === 'motherName'
          ? 'motherName'
          : entry.key === 'phone'
            ? 'phone'
            : null;
    if (!target) return entry;
    return {
      ...entry,
      cells: [0, 1].map((side) => (
        <span key={side} className="block">
          {entry.cells[side as 0 | 1]}
          {editCell(side as 0 | 1, target)}
        </span>
      )) as [React.ReactNode, React.ReactNode],
    };
  });

  return (
    <CompareShell finding={finding} locale={locale} onBack={onBack}>
      <DifferenceSummary rows={rows} locale={locale} />

      {!canEdit ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {en
              ? 'Your role reviews records but does not change them. Open either file to have an administrative officer correct it.'
              : 'دورك يراجع السجلات ولا يعدّلها. افتح الملف ليصحّحه موظف إداري.'}
          </span>
        </p>
      ) : null}

      <CompareTable
        locale={locale}
        headers={[
          <RecordHeading
            key="a"
            title={people[0].fullName}
            secondary={people[0].referenceNumber}
            href={`${base}/citizens/${encodeURIComponent(people[0].id)}`}
            openLabel={en ? 'Open the file' : 'فتح الملف'}
          />,
          <RecordHeading
            key="b"
            title={people[1].fullName}
            secondary={people[1].referenceNumber}
            href={`${base}/citizens/${encodeURIComponent(people[1].id)}`}
            openLabel={en ? 'Open the file' : 'فتح الملف'}
          />,
        ]}
        shortHeaders={[people[0].fullName, people[1].fullName]}
        rows={withEditing}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        {en
          ? 'Nothing here merges two records. If this is one person, correct the record that is wrong and move the property onto the file that stays — a merge cannot be undone.'
          : 'لا شيء هنا يدمج سجلّين. إن كانا شخصاً واحداً فصحِّح السجل الخاطئ وانقل العقار إلى الملف الباقي — الدمج لا يمكن التراجع عنه.'}
      </p>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        destructive={false}
        title={en ? 'Save this change?' : 'هل أنت متأكد من إجراء هذا التغيير؟'}
        description={
          pending ? (
            <span className="block space-y-2">
              <span className="block">
                {en
                  ? 'This writes to the citizen’s file and is recorded in the audit trail.'
                  : 'يُكتب هذا في ملف المواطن ويُسجَّل في سجل التدقيق.'}
              </span>
              <span className="block rounded-md border bg-muted/40 p-2.5 text-sm">
                <span className="block text-xs text-muted-foreground">{pending.label}</span>
                <ChangeValue
                  before={pending.before}
                  after={pending.after}
                  becameLabel={en ? 'becomes' : 'يصبح'}
                />
              </span>
            </span>
          ) : null
        }
        confirmLabel={en ? 'Save' : 'موافق — احفظ'}
        cancelLabel={en ? 'Cancel' : 'إلغاء'}
        onConfirm={save}
      />
    </CompareShell>
  );
}

// ─────────────────────────────  Buildings  ─────────────────────────────

function buildingRows(a: BuildingDetail, b: BuildingDetail, locale: string): CompareRow[] {
  const labels = getLabels(locale);
  const en = locale === 'en';

  const coordinates = (building: BuildingDetail) =>
    building.latitude == null || building.longitude == null
      ? null
      : `${building.latitude.toFixed(5)}, ${building.longitude.toFixed(5)}`;

  return [
    row('code', en ? 'Code' : 'الرمز', a.code, b.code),
    row('name', en ? 'Name' : 'اسم المبنى', a.name, b.name),
    row('posted', en ? 'Number painted on it' : 'الرقم المدهون', a.postedNumber, b.postedNumber),
    row('parcel', en ? 'Parcel' : 'رقم العقار', a.parcelNumber, b.parcelNumber),
    row('zone', en ? 'Sector' : 'القطاع', a.zoneName ?? a.zoneCode, b.zoneName ?? b.zoneCode),
    row(
      'structureType',
      en ? 'Structure' : 'نوع المنشأة',
      (labels.structureType as Record<string, string>)[a.structureType] ?? a.structureType,
      (labels.structureType as Record<string, string>)[b.structureType] ?? b.structureType,
    ),
    row(
      'lifecycle',
      en ? 'Condition' : 'الحالة الإنشائية',
      (labels.buildingLifecycle as Record<string, string>)[a.lifecycleStatus] ?? a.lifecycleStatus,
      (labels.buildingLifecycle as Record<string, string>)[b.lifecycleStatus] ?? b.lifecycleStatus,
    ),
    row('floors', en ? 'Floors' : 'عدد الطوابق', a.floorsCount, b.floorsCount),
    row('basements', en ? 'Basements' : 'عدد الأقبية', a.basementsCount ?? 0, b.basementsCount ?? 0),
    row('units', en ? 'Units' : 'عدد الوحدات', a.unitsTotal, b.unitsTotal),
    row('surveyed', en ? 'Units surveyed' : 'الوحدات الممسوحة', a.unitsSurveyed, b.unitsSurveyed),
    row('pin', en ? 'Entrance pin' : 'إحداثيات المدخل', coordinates(a), coordinates(b)),
    row('createdAt', en ? 'Created on' : 'تاريخ الإنشاء', formatDate(a.createdAt), formatDate(b.createdAt)),
    row('notes', en ? 'Notes' : 'ملاحظات', a.notes, b.notes),
  ];
}

function BuildingCompare({
  finding,
  pair,
  tenant,
  base,
  locale,
  token,
  onBack,
}: {
  finding: QualityFinding;
  pair: { a: FindingSubject; b: FindingSubject };
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  onBack: () => void;
}): React.JSX.Element {
  const en = locale === 'en';

  const query = useStaffQuery({
    queryKey: ['quality-compare-buildings', tenant, pair.a.id, pair.b.id],
    queryFn: (tok, signal) =>
      Promise.all([
        getBuilding(tenant, tok, pair.a.id, signal),
        getBuilding(tenant, tok, pair.b.id, signal),
      ]),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the two structures.' : 'تعذّر تحميل المبنيين.',
    keepPrevious: true,
  });

  if (query.error) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <ErrorState description={query.error} onRetry={query.refetch} />
      </CompareShell>
    );
  }

  if (query.loading || !query.data) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <LoadingState label={en ? 'Loading both structures…' : 'جارٍ تحميل المبنيين…'} />
      </CompareShell>
    );
  }

  const buildings = query.data;
  const rows = buildingRows(buildings[0], buildings[1], locale);

  return (
    <CompareShell finding={finding} locale={locale} onBack={onBack}>
      <DifferenceSummary rows={rows} locale={locale} />

      <CompareTable
        locale={locale}
        headers={[
          <RecordHeading
            key="a"
            title={buildings[0].name ? `${buildings[0].code} — ${buildings[0].name}` : buildings[0].code}
            secondary={
              en ? `Parcel ${buildings[0].parcelNumber}` : `عقار ${buildings[0].parcelNumber}`
            }
            href={`${base}/buildings/${encodeURIComponent(buildings[0].id)}/matrix`}
            openLabel={en ? 'Open the matrix' : 'فتح مصفوفة الوحدات'}
          />,
          <RecordHeading
            key="b"
            title={buildings[1].name ? `${buildings[1].code} — ${buildings[1].name}` : buildings[1].code}
            secondary={
              en ? `Parcel ${buildings[1].parcelNumber}` : `عقار ${buildings[1].parcelNumber}`
            }
            href={`${base}/buildings/${encodeURIComponent(buildings[1].id)}/matrix`}
            openLabel={en ? 'Open the matrix' : 'فتح مصفوفة الوحدات'}
          />,
        ]}
        shortHeaders={[buildings[0].code, buildings[1].code]}
        rows={rows}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        {en
          ? 'Two structures metres apart on one parcel are a question, not a verdict — genuine neighbours stand that close here too. If they are one structure, correct it in the building editor; if they are two, mark this resolved with the reason.'
          : 'مبنيان متلاصقان على عقار واحد سؤال لا حكم — فالجيران الحقيقيون هنا يقفون بهذا القرب أيضاً. إن كانا مبنى واحداً فصحِّحه في محرِّر المباني، وإن كانا اثنين فعلِّم الملاحظة «تم الحل» مع السبب.'}
      </p>
    </CompareShell>
  );
}

// ─────────────────────────────  Entry point  ─────────────────────────────

export function FindingCompare({
  finding,
  tenant,
  base,
  locale,
  token,
  canEdit,
  onBack,
  onChanged,
}: {
  finding: QualityFinding;
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  /** Whether this viewer's role may write to a citizen's file at all. */
  canEdit: boolean;
  onBack: () => void;
  /** A correction landed — the queue behind this screen is now stale. */
  onChanged: () => void;
}): React.JSX.Element {
  const pair = comparablePairOf(finding);

  if (!pair) {
    // Reachable only if a finding changed shape between the row being drawn and
    // the button being pressed. Says so rather than rendering an empty grid.
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          {locale === 'en'
            ? 'This finding names a single record, so there is nothing to set against it.'
            : 'هذه الملاحظة تخص سجلاً واحداً، فلا يوجد ما يُقارن به.'}
        </p>
      </CompareShell>
    );
  }

  return pair.kind === 'citizen' ? (
    <CitizenCompare
      finding={finding}
      pair={pair}
      tenant={tenant}
      base={base}
      locale={locale}
      token={token}
      canEdit={canEdit}
      onBack={onBack}
      onChanged={onChanged}
    />
  ) : (
    <BuildingCompare
      finding={finding}
      pair={pair}
      tenant={tenant}
      base={base}
      locale={locale}
      token={token}
      onBack={onBack}
    />
  );
}
