'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  KeyRound,
  Loader2,
  Receipt,
  Table2,
  Target,
  UserRound,
  Users,
  UserSearch,
} from 'lucide-react';
import {
  CITIZEN_RESIDENCE,
  getLabels,
  FEE_FREQUENCY,
  FEE_BASIS,
  FEE_BEARER,
  FEE_TARGET_CATEGORY,
} from '@mechanization/shared-schemas';
import type { FeeBasis, FeeBearer, FeeFrequency, FeeNoticePreviewResult } from '@mechanization/shared-schemas';
import { FormSection } from '@/components/admin/fees/form-section';
import { NoticeReview } from '@/components/admin/fees/notice-review';
import { NoticeScopeFields, SCOPE_FIELD_ID, ScopeWarnings } from '@/components/admin/fees/notice-scope';
import { bracketFieldId, MATRIX_ADD_ID, TieredMatrixEditor } from '@/components/admin/fees/tiered-matrix-editor';
import {
  matrixIssues,
  noticeIssues,
  noticeWarnings,
  STEP_FIELDS,
  stepOf,
  occupancyOf,
  UNIT_OCCUPANCY,
  unitStatesFor,
  unitStatesOf,
  type BracketField,
  type CheckedStep,
  type NoticeDraft,
  type NoticeField,
  type UnitOccupancy,
} from '@/lib/fee-notice-draft';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DatePicker } from '@/components/ui/date-picker';
import { ChoiceCard, Field } from '@/components/ui/field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { BillTypeSelect } from '@/components/admin/bill-type-select';
import { CitizenPicker, type PickedCitizen } from '@/components/admin/citizen-picker';
import { formatTypedAmount } from '@/lib/currency';
import { useLeaveGuard } from '@/lib/use-leave-guard';
import { cn } from '@/lib/utils';

/** The wizard's fields, as typed — see `NoticeDraft`, and `noticePayload` for what is sent. */
export type IssueFeeValues = NoticeDraft;

const EMPTY: IssueFeeValues = {
  title: '',
  amount: '',
  // Flat by default, deliberately. Moving a fee onto a per-unit basis changes
  // what residents owe, so it is a thing a clerk chooses on purpose.
  basis: 'FLAT',
  /*
    And the occupant bears it by default — the commoner case, and the one that
    changes nothing.

    On a register where حالة الوحدة has not been recorded, an unmarked unit
    reads as occupied by its owner, so this bills the owner for everything they
    hold and each tenant for their own card: exactly the arithmetic that came
    before any of this existed. Choosing المالك instead is a real change to
    what residents owe, which is why it is a visible choice next to the basis
    rather than a default anyone can arrive at without meaning to.
  */
  bearer: 'OCCUPANT',
  frequency: 'MONTHLY',
  /*
    «من يشمل الإشعار» (0100) starts where a notice to everyone always started:
    every category, the statuses the bearer charges, every kind of file — the
    notice from before, sent with no scope at all (`noticePayload`).
  */
  audience: 'ALL',
  categories: [...FEE_TARGET_CATEGORY],
  unitStates: null,
  residences: [...CITIZEN_RESIDENCE],
  scopeConfirmed: false,
  targetCitizenId: '',
  dueDate: '',
  instructions: '',
  matrixBrackets: [],
};

/** One glyph per bearer, so the two are told apart before they are read. */
const BEARER_ICON = {
  OCCUPANT: UserRound,
  OWNER: KeyRound,
} as const;

const AUDIENCE_ICON = {
  ALL: Users,
  INDIVIDUAL: UserSearch,
} as const;

/** How long a refused «التالي» stays said at the foot of the screen: the toast's warning default. */
const REFUSAL_TOAST_MS = 7000;

/** The fields whose change makes the scope's warnings, and so their confirmation, another question. */
const SCOPE_INPUTS = ['basis', 'bearer', 'audience', 'categories', 'unitStates', 'residences'] as const;

type StepId = 'details' | 'brackets' | 'target' | 'review';

/** «جدول الفئات» is a step only under TIERED_AREA, where the table is the notice's money. */
const ALL_STEPS: Array<{ id: StepId; icon: typeof Receipt }> = [
  { id: 'details', icon: Receipt },
  { id: 'brackets', icon: Table2 },
  { id: 'target', icon: Target },
  { id: 'review', icon: ClipboardList },
];

/** Where each refused field takes the focus; the bracket table's is its first bad field (`firstBracketFieldId`). */
const FIELD_ID: Record<Exclude<NoticeField, 'matrixBrackets'>, string> = {
  title: 'fee-title',
  amount: 'fee-amount',
  dueDate: 'fee-due',
  instructions: 'fee-instructions',
  ...SCOPE_FIELD_ID,
  targetCitizenId: 'fee-citizen',
};

const BRACKET_FIELD_ORDER: BracketField[] = ['code', 'labelAr', 'minArea', 'maxArea', 'levels', 'amount', 'unitTypes'];

/**
 * The first field to fix in the bracket table, its first bracket when the
 * problem is across it (a gap), or «أضف فئة» when it has none.
 */
function firstBracketFieldId(values: IssueFeeValues): string {
  const { rows } = matrixIssues(values.matrixBrackets);
  for (const [index, row] of rows.entries()) {
    const field = BRACKET_FIELD_ORDER.find((name) => row[name]);
    const draft = values.matrixBrackets[index];
    // An extension types only its amount: anything else it is refused for is its base's field to fix.
    const owner = draft?.extendsKey && field !== 'amount' ? draft.extendsKey : draft?.key;
    if (field && owner) return bracketFieldId(owner, field);
  }
  const first = values.matrixBrackets[0];
  return first ? bracketFieldId(first.key, 'minArea') : MATRIX_ADD_ID;
}

/**
 * «إصدار رسم جديد» — the three steps, on their own page.
 *
 * It was a dialog, which BAN-10 refuses for a task that needs neither
 * interruption nor protected focus: issuing a fee is a three-step wizard that
 * decides what every household in the town owes, and it is read and re-read
 * before the last button. A route gives it an address, a back button that means
 * what it says, and no overlay for a half-filled wizard to be lost to; leaving
 * it by a link or a reload once anything is typed asks first (`useLeaveGuard`).
 *
 * Each step is checked against the schema the server checks the notice by
 * (`noticeIssues`), when «التالي» is pressed: the step's refusals show under
 * their fields and the focus goes to the first (FRM-2), rather than a disabled
 * button that never says why.
 *
 * Every step takes the page's width, and lays it out for what it asks: the
 * details and the scope as rows of questions (`FormSection`), each named
 * beside its fields, the bracket table's eight columns, and on the review the
 * read-back beside the preview it is checked against. The actions stay pinned to the foot of the scroll, so
 * «إصدار» is in reach under a town-wide preview's tables. A change of step moves
 * the focus to the new step's heading, which says where the clerk is.
 *
 * The page owns the submit and what follows it (the counts of what went
 * unbilled); this owns the steps and the fields.
 */
export function IssueFeeForm({
  tenant,
  base,
  token,
  submitting,
  error,
  onSubmit,
  onEdit,
  backHref,
  locale = 'ar',
  existingTitles = [],
}: {
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}`, for the preview's read. */
  base: string;
  /** The staff session's token; the citizen picker searches the register with it. */
  token: string | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: IssueFeeValues) => Promise<void>;
  /** Any field changed: a failed issue's message no longer describes the notice on screen (N3). */
  onEdit?: () => void;
  /** Where «إلغاء» goes from the first step. */
  backHref: string;
  locale?: string;
  existingTitles?: string[];
}) {
  const labels = getLabels(locale);
  const t = useTranslations('fees.issueForm');
  const tMatrix = useTranslations('fees.matrix');
  const toast = useToast();
  /** The refusal the last toast said, and when: a second press of the same one is not stacked. */
  const lastRefusal = useRef<{ said: string; at: number } | null>(null);
  const [values, setValues] = useState<IssueFeeValues>(EMPTY);
  /** The preview's answer for the notice on screen; «إصدار» waits for it. */
  const [preview, setPreview] = useState<FeeNoticePreviewResult | null>(null);
  const onPreview = useCallback((result: FeeNoticePreviewResult | null) => setPreview(result), []);
  /** The file chosen in the picker (`CitizenPicker`), whose id `values.targetCitizenId` carries. */
  const [picked, setPicked] = useState<PickedCitizen | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  /** The new step's heading takes the focus after a move the clerk made, never on the first paint or a failed issue's return. */
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const goTo = (next: number) => {
    if (next === stepIndex) return;
    moved.current = true;
    setStepIndex(next);
  };
  /** The steps whose «التالي» has been pressed: their refusals show from then on, and clear as they are fixed. */
  const [checked, setChecked] = useState<Record<CheckedStep, boolean>>({
    details: false,
    brackets: false,
    target: false,
  });
  /** «لا يطال هذا الرسم أحداً»: issuing it anyway is asked once more (S7). */
  const [confirmZero, setConfirmZero] = useState(false);

  // Anything typed is something to lose; `set` is the only writer, and it always makes a new object.
  const guard = useLeaveGuard(values !== EMPTY && !submitting);

  // «حسب فئة المساحة» (0098): the brackets carry the money, on a step of their own; there is no amount to type.
  const tiered = values.basis === 'TIERED_AREA';
  const steps = tiered ? ALL_STEPS : ALL_STEPS.filter((step) => step.id !== 'brackets');
  const lastStep = steps.length - 1;
  /**
   * A failed submit sends the clerk back to المراجعة.
   *
   * Without this a server rejection ("مبلغ كبير جداً") would be shown under
   * whichever step they had since navigated to, describing a field that is not
   * on screen.
   */
  useEffect(() => {
    if (error) setStepIndex(lastStep);
  }, [error, lastStep]);

  const set = (patch: Partial<IssueFeeValues>) => {
    setValues((previous) => {
      const next = { ...previous, ...patch };
      // The statuses follow the bearer until the clerk ticks one under it: a new bearer starts from its own.
      if (patch.bearer && patch.bearer !== previous.bearer) next.unitStates = null;
      // A confirmation answers the warnings it was given, not the ones a changed scope raises.
      if (SCOPE_INPUTS.some((field) => field in patch)) next.scopeConfirmed = false;
      return next;
    });
    onEdit?.();
  };

  const chosen = picked && picked.id === values.targetCitizenId ? picked : undefined;
  const recurring = values.frequency !== 'ONCE';
  const flat = values.basis === 'FLAT';
  /** «الوحدات المشمولة»: which of the three the notice's statuses are, or null for a mix from the scope step. */
  const occupancy = occupancyOf(unitStatesOf(values));

  const issues = noticeIssues(values);
  const stepIssues = (step: CheckedStep): NoticeField[] =>
    (STEP_FIELDS[step] as readonly NoticeField[]).filter((field) => issues[field]);
  /** A field's refusal, once its step has been checked. */
  const fieldError = (field: NoticeField): string | undefined => (checked[stepOf(field)] ? issues[field] : undefined);

  const current = steps[Math.min(stepIndex, lastStep)]!;
  const isLast = stepIndex === lastStep;
  // A preview answers for the notice it was read for: leaving the review step drops it.
  useEffect(() => {
    if (current.id !== 'review') setPreview(null);
  }, [current.id]);
  // The button pressed may be gone with the step it was on; the heading says which step this is (A11Y-5).
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    stepHeading.current?.focus();
  }, [current.id]);
  const detailsOk = stepIssues('details').length === 0;
  // Nothing to refuse outside TIERED_AREA, where no table is sent.
  const bracketsOk = stepIssues('brackets').length === 0;
  const targetOk = stepIssues('target').length === 0;
  // «من يشمل الإشعار»: a scope that departs from the law is issued only once the clerk confirms it.
  const warnings = noticeWarnings(values);
  const scopeOk = warnings.length === 0 || values.scopeConfirmed;
  // Issued only once the preview has answered for this notice: the clerk has seen what it raises.
  const canSubmit = detailsOk && bracketsOk && targetOk && scopeOk && preview !== null;
  const billsNobody = preview !== null && preview.billedCitizens === 0 && preview.sharedBills === 0;

  /** «التالي»: on to the next step, or the step's refusals shown and the focus on the first. */
  const advance = () => {
    if (current.id === 'review') return;
    const step = current.id;
    const refused = stepIssues(step);
    if (refused.length === 0) {
      goTo(stepIndex + 1);
      return;
    }
    setChecked((previous) => ({ ...previous, [step]: true }));
    // Every bracket shows its problems now, not only the ones the focus has left.
    if (refused.includes('matrixBrackets')) {
      setValues((previous) => ({
        ...previous,
        matrixBrackets: previous.matrixBrackets.map((draft) => ({ ...draft, touched: true })),
      }));
    }
    const first = refused[0]!;
    /*
      Said at the foot of the screen, as a toast that never takes the focus
      (A11Y-5), and not under the field: the user's decision (2026-10-27),
      FRM-2's exception for this wizard. The field keeps its mark once the
      toast has closed — a red label (`Field`'s `errorElsewhere`) or a red
      border on a bracket cell — and its message for a screen reader. The same
      refusal pressed again while its toast is up is not stacked a second time.
    */
    const said = refused.map((field) => issues[field]).join('\n');
    const now = Date.now();
    if (lastRefusal.current?.said !== said || now - lastRefusal.current.at > REFUSAL_TOAST_MS) {
      lastRefusal.current = { said, at: now };
      toast.warning(issues[first]!, {
        description: refused.length > 1 ? t('refused.more', { count: refused.length - 1 }) : undefined,
        duration: REFUSAL_TOAST_MS,
      });
    }
    const id = first === 'matrixBrackets' ? firstBracketFieldId(values) : FIELD_ID[first];
    // After the paint that shows the message, so the field is read with it.
    if (id) requestAnimationFrame(() => document.getElementById(id)?.focus());
  };

  const issue = () => {
    if (billsNobody) {
      setConfirmZero(true);
      return;
    }
    void onSubmit(values);
  };

  return (
    // `overflow-clip`, not `-hidden`: the same rounded clip, without making the
    // card a scroll container that the preview's sticky figures and the pinned
    // actions would stick to instead of the page's scroll.
    <div className="w-full overflow-clip rounded-lg border bg-card">
      <div className="border-b p-4 sm:px-6">
        <Stepper
          label={t('stepsLabel')}
          index={stepIndex}
          steps={steps.map((step) => ({ id: step.id, title: t(`steps.${step.id}`) }))}
          onSelect={(next) => goTo(Math.min(next, stepIndex))}
        />
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        {/* Read when the focus lands on it; the stepper above already shows the same to the eye. */}
        <h2 ref={stepHeading} tabIndex={-1} className="sr-only">
          {t('stepHeading', { step: stepIndex + 1, total: steps.length, title: t(`steps.${current.id}`) })}
        </h2>

        {/* The primitive CTL-12 asked for, in place of this file's hand-rolled banner. */}
        {error ? (
          <Alert variant="destructive" live="alert">
            {error}
          </Alert>
        ) : null}

        {/*
          Keyed by the step, so the one that arrives fades in (MOT-2, MOT-4):
          opacity only, 150ms, cut to nothing under reduced motion (MOT-6). A
          slide would say the steps are places side by side; they are a sequence.
        */}
        <div key={current.id} className="space-y-5 duration-150 ease-out animate-in fade-in-0">
          {current.id === 'details' ? (
            // Two questions, each a row (`FormSection`): what is charged, then when it falls due and how it is paid.
            <div className="divide-y">
              <FormSection title={t('sections.fee.title')} description={t('sections.fee.hint')}>
                <Field label={t('title')} htmlFor="fee-title" required error={fieldError('title')} errorElsewhere>
                  <BillTypeSelect
                    id="fee-title"
                    locale={locale}
                    value={values.title}
                    onChange={(title) => set({ title })}
                    existingTitles={existingTitles}
                    placeholder={t('titlePlaceholder')}
                  />
                </Field>

                {/* `grid-cols-1`, not the implicit `auto` track, which grows to its widest content and runs past a phone. */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t('basis')} htmlFor="fee-basis" required>
                    <Select value={values.basis} onValueChange={(next) => set({ basis: next as FeeBasis })}>
                      <SelectTrigger id="fee-basis">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FEE_BASIS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {labels.feeBasis[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  {tiered ? (
                    // No amount here: the next step's table carries the money. Set where the amount would be.
                    <p className="flex items-center gap-2 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground sm:self-end">
                      <Table2 className="size-4 shrink-0" aria-hidden />
                      {t('tieredNext')}
                    </p>
                  ) : (
                    <Field
                      label={t('amount', { basis: values.basis })}
                      htmlFor="fee-amount"
                      required
                      error={fieldError('amount')}
                      errorElsewhere
                    >
                      <CurrencyInput
                        id="fee-amount"
                        unit={t('lbp')}
                        placeholder="500,000"
                        value={values.amount}
                        invalid={Boolean(fieldError('amount'))}
                        // At both breakpoints: `Input`'s `sm:text-sm` wins from 640px otherwise (PRIM-25).
                        inputClassName="text-lg font-semibold sm:text-lg"
                        onChange={(raw) => set({ amount: formatTypedAmount(raw, 0) })}
                      />
                    </Field>
                  )}
                </div>

                {/*
                  Hidden under FLAT, where it decides nothing.

                  A flat notice charges its amount to everyone it targets and
                  never asks the register what they hold, so there is no unit
                  for a bearer rule to include or exclude. Showing the control
                  there would offer a clerk a lever that does not move — and the
                  value is preserved rather than reset, so a notice toggled to
                  FLAT and back does not quietly lose the choice on the way.

                  Two cards rather than a dropdown because this is the sentence
                  that decides who in the town pays: both answers are on screen
                  at the moment of choosing, not one behind a click. Titles only
                  (the user's decision, 2026-10-27): the paragraph under each
                  crowded the step, and what the choice means is said where it
                  takes effect — each box of «حالة الوحدة» on the next step names
                  who pays for it under this bearer.
                */}
                {flat ? null : (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">
                      {t('bearer')} <span className="text-destructive" aria-hidden>*</span>
                    </legend>
                    <div role="radiogroup" aria-label={t('bearer')} className="grid gap-2 sm:grid-cols-2">
                      {FEE_BEARER.map((option) => (
                        <ChoiceCard
                          key={option}
                          name="fee-bearer"
                          value={option}
                          checked={values.bearer === option}
                          onChange={(next) => set({ bearer: next as FeeBearer })}
                          title={labels.feeBearer[option]}
                          icon={BEARER_ICON[option]}
                        />
                      ))}
                    </div>
                  </fieldset>
                )}

                {/*
                  «الوحدات المشمولة»: occupied, vacant or both — the short answer
                  to «حالة الوحدة», which the scope step asks box by box. One
                  value behind both (`unitStatesFor`, `occupancyOf`), so a mix
                  ticked there selects none of the three here and says so. Under
                  the bearer, which sets its default, and hidden under FLAT with
                  it: a flat fee charges a person, not a unit.
                */}
                {flat ? null : (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">{t('occupancy.label')}</legend>
                    <SegmentedControl
                      aria-label={t('occupancy.label')}
                      value={occupancy ?? ''}
                      onChange={(next) =>
                        set({ unitStates: unitStatesFor(next as UnitOccupancy, values.bearer) })
                      }
                      options={UNIT_OCCUPANCY.map((option) => ({
                        value: option,
                        label: t(`occupancy.${option}`),
                      }))}
                    />
                    {occupancy === null ? (
                      <p className="text-xs text-muted-foreground">{t('occupancy.custom')}</p>
                    ) : null}
                  </fieldset>
                )}
              </FormSection>

              <FormSection title={t('sections.schedule.title')} description={t('sections.schedule.hint')}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t('dueDate')} htmlFor="fee-due" required error={fieldError('dueDate')} errorElsewhere>
                    <DatePicker
                      id="fee-due"
                      value={values.dueDate}
                      onChange={(dueDate) => set({ dueDate })}
                      locale={locale === 'en' ? 'en' : 'ar'}
                    />
                  </Field>

                  <Field label={t('frequency')} htmlFor="fee-frequency" required>
                    <Select
                      value={values.frequency}
                      onValueChange={(next) => set({ frequency: next as FeeFrequency })}
                    >
                      <SelectTrigger id="fee-frequency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FEE_FREQUENCY.map((option) => (
                          <SelectItem key={option} value={option}>
                            {labels.feeFrequency[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                {/* Kept with the notice: part of it, so asked with it rather than with who it reaches. */}
                <Field label={t('instructions')} htmlFor="fee-instructions" error={fieldError('instructions')} errorElsewhere>
                  <Textarea
                    id="fee-instructions"
                    rows={3}
                    value={values.instructions}
                    onChange={(event) => set({ instructions: event.target.value })}
                  />
                </Field>
              </FormSection>
            </div>
          ) : null}

          {current.id === 'brackets' ? (
            <section aria-labelledby="fee-brackets-title" className="space-y-3">
              <h3 id="fee-brackets-title" className="text-base font-semibold">
                {tMatrix('field')} <span className="text-destructive" aria-hidden>*</span>
              </h3>
              <TieredMatrixEditor
                value={values.matrixBrackets}
                onChange={(matrixBrackets) => set({ matrixBrackets })}
                locale={locale}
                showErrors={checked.brackets}
              />
            </section>
          ) : null}

          {current.id === 'target' ? (
            <>
              {/* Who first, then «من يشمل الإشعار» (0100): حالة الوحدة، نوع الإقامة، نوع العقار — in that order. */}
              <div className="divide-y">
                <FormSection title={t('target')} required>
                  <div role="radiogroup" aria-label={t('target')} className="grid gap-3 sm:grid-cols-2">
                    {(['ALL', 'INDIVIDUAL'] as const).map((option) => (
                      <ChoiceCard
                        key={option}
                        name="fee-target"
                        value={option}
                        checked={values.audience === option}
                        onChange={(next) => set({ audience: next as IssueFeeValues['audience'], targetCitizenId: '' })}
                        title={t(`audience.${option}.title`)}
                        description={t(`audience.${option}.hint`)}
                        icon={AUDIENCE_ICON[option]}
                      />
                    ))}
                  </div>

                  {values.audience === 'INDIVIDUAL' ? (
                    <Field
                      label={t('citizen')}
                      htmlFor="fee-citizen"
                      required
                      error={fieldError('targetCitizenId')}
                      errorElsewhere
                      // A name and a reference read in a line: the section's width only puts the answer far from the box.
                      className="md:max-w-xl"
                    >
                      <CitizenPicker
                        id="fee-citizen"
                        tenant={tenant}
                        token={token}
                        value={chosen ?? null}
                        onChange={(citizen) => {
                          setPicked(citizen);
                          set({ targetCitizenId: citizen?.id ?? '' });
                        }}
                      />
                    </Field>
                  ) : null}
                </FormSection>

                <NoticeScopeFields values={values} set={set} locale={locale} fieldError={fieldError} />
              </div>

              {/* What this scope departs from in the law, said as it is ticked; the review asks to confirm it. */}
              <ScopeWarnings values={values} locale={locale} />
            </>
          ) : null}

          {current.id === 'review' ? (
            // Read back as rows, with what it raises pinned over them and the confirmation last (`NoticeReview`).
            <NoticeReview
              values={values}
              set={set}
              locale={locale}
              tenant={tenant}
              base={base}
              token={token}
              chosen={chosen}
              ready={detailsOk && bracketsOk && targetOk}
              onPreview={onPreview}
              onEdit={(step) => goTo(steps.findIndex((candidate) => candidate.id === step))}
            />
          ) : null}
        </div>
      </div>

      {/*
        Pinned to the foot of the page's scroll while the step runs past it —
        the scope's boxes, a town's preview — so the way on is never a scroll
        away; at the card's foot otherwise. Clear of a phone's home indicator.
      */}
      <div className="sticky bottom-0 z-10 flex flex-row items-center justify-between gap-2 border-t bg-card px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
        {stepIndex === 0 ? (
          <Button asChild variant="ghost">
            <Link href={backHref}>{t('cancel')}</Link>
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => goTo(stepIndex - 1)} disabled={submitting}>
            {/* Back points back: drawn for LTR, flipped in Arabic, and «التالي» below takes the opposite arrow (RTL-3). */}
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            {t('back')}
          </Button>
        )}

        {isLast ? (
          <Button disabled={!canSubmit || submitting} onClick={issue}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
            {t('issue')}
          </Button>
        ) : (
          <Button onClick={advance}>
            {t('next')}
            <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmZero}
        onOpenChange={setConfirmZero}
        title={t('zero.title')}
        description={t('zero.body', { recurring: String(recurring) })}
        confirmLabel={t('zero.confirm')}
        cancelLabel={t('zero.cancel')}
        destructive={false}
        onConfirm={() => onSubmit(values)}
      />

      <ConfirmDialog
        open={guard.pendingHref !== null}
        onOpenChange={(open) => {
          if (!open) guard.stay();
        }}
        title={t('leave.title')}
        description={t('leave.body')}
        confirmLabel={t('leave.confirm')}
        cancelLabel={t('leave.cancel')}
        onConfirm={guard.leave}
      />
    </div>
  );
}

/**
 * The steps across the card's width, each joined to the next by a rule that
 * fills the space between them. Below `sm` only the current step keeps its
 * title on screen, the others their number; the titles stay in the
 * accessibility tree, so every button is still named.
 */
function Stepper({
  label,
  index,
  steps,
  onSelect,
}: {
  label: string;
  index: number;
  steps: Array<{ id: StepId; title: string }>;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex items-center gap-2" aria-label={label}>
      {steps.map((step, position) => {
        const isActive = position === index;
        // Behind is done: «التالي» moves on only from a step the schema takes.
        const done = position < index;
        const last = position === steps.length - 1;

        return (
          <li
            key={step.id}
            className={cn(
              'flex min-w-0 items-center gap-2',
              // On a phone the current step takes the room its title needs; from `sm` the rules share it.
              isActive ? 'flex-1' : 'shrink-0',
              last ? 'sm:flex-none' : 'sm:flex-1',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(position)}
              disabled={position > index}
              aria-current={isActive ? 'step' : undefined}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors coarse:min-h-touch',
                position <= index ? 'hover:bg-accent' : 'cursor-default',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ring-1',
                  isActive
                    ? 'bg-primary text-primary-foreground ring-primary'
                    : done
                      ? 'bg-success/10 text-success ring-success/40'
                      : 'bg-muted text-muted-foreground ring-border',
                )}
              >
                {/* Latin digits in both locales, as every other figure on the screen (TYP-4). */}
                {done ? <Check className="size-3.5" /> : position + 1}
              </span>
              <span
                className={cn(
                  'truncate font-medium',
                  isActive ? 'text-foreground' : 'sr-only text-muted-foreground sm:not-sr-only',
                )}
              >
                {step.title}
              </span>
            </button>
            {last ? null : (
              <span aria-hidden className={cn('h-px min-w-3 flex-1', done ? 'bg-primary/40' : 'bg-border')} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The wizard's frame while the session and the titles in use are read: the
 * stepper, the details step's rows and the actions, where they will be, so
 * nothing moves when the form arrives.
 */
export function IssueFeeFormSkeleton({ label }: { label: string }) {
  return (
    <div role="status" className="w-full rounded-lg border bg-card">
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-2 border-b p-4 sm:px-6" aria-hidden>
        {[0, 1, 2].map((step) => (
          <Fragment key={step}>
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="hidden h-4 w-20 shrink-0 sm:block" />
            {step < 2 ? <Skeleton className="h-px min-w-3 flex-1" /> : null}
          </Fragment>
        ))}
      </div>
      {/* The details step's two rows as `FormSection` draws them: a heading and its line, then the fields. */}
      <div className="divide-y p-4 sm:p-6" aria-hidden>
        {[3, 3].map((fields, row) => (
          <div
            key={row}
            className="grid grid-cols-1 gap-x-10 gap-y-4 py-6 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
          >
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-40" />
            </div>
            <div className="grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
              {Array.from({ length: fields }, (_, field) => (
                <div key={field} className={cn('space-y-2', field === 0 && 'sm:col-span-2')}>
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t p-4 sm:px-6" aria-hidden>
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-28" />
      </div>
    </div>
  );
}
