'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarClock,
  Check,
  ClipboardList,
  KeyRound,
  Loader2,
  Receipt,
  Target,
  TriangleAlert,
  UserRound,
  Users,
  UserSearch,
} from 'lucide-react';
import {
  getLabels,
  FEE_FREQUENCY,
  FEE_BASIS,
  FEE_BEARER,
  FEE_TARGET_CATEGORY,
  FEE_TARGET_TYPE,
} from '@mechanization/shared-schemas';
import type { FeeBasis, FeeBearer } from '@mechanization/shared-schemas';
import type { CitizenListItem } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { BillTypeSelect } from '@/components/admin/bill-type-select';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';

export interface IssueFeeValues {
  title: string;
  amount: string;
  /** What `amount` is per — see `FEE_BASIS`. */
  basis: FeeBasis;
  /** Who owes it — see `FEE_BEARER`. Only consulted when basis is not FLAT. */
  bearer: FeeBearer;
  frequency: string;
  targetType: string;
  targetCategory: string;
  targetCitizenId: string;
  dueDate: string;
  instructions: string;
}

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
  targetType: 'ALL_CITIZENS',
  targetCategory: 'SHOP',
  targetCitizenId: '',
  dueDate: '',
  instructions: '',
};

/** One glyph per bearer, so the two are told apart before they are read. */
const BEARER_ICON = {
  OCCUPANT: UserRound,
  OWNER: KeyRound,
} as const;

const TARGET_ICON = {
  ALL_CITIZENS: Users,
  BUILDING_CATEGORY: Building2,
  INDIVIDUAL_CITIZEN: UserSearch,
} as const;

function formatLbp(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits ? Number(digits).toLocaleString('en-US') : '';
}

export function IssueFeeDialog({
  open,
  onOpenChange,
  citizens,
  submitting,
  error,
  onSubmit,
  locale = 'ar',
  existingTitles = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  citizens: CitizenListItem[];
  submitting: boolean;
  error: string | null;
  onSubmit: (values: IssueFeeValues) => void;
  locale?: string;
  existingTitles?: string[];
}) {
  const labels = getLabels(locale);
  const [values, setValues] = useState<IssueFeeValues>(EMPTY);
  const [citizenQuery, setCitizenQuery] = useState('');
  const [stepIndex, setStepIndex] = useState(0);

  const steps = [
    { id: 'details' as const, step: locale === 'en' ? '1' : '١', title: locale === 'en' ? 'Details' : 'التفاصيل', icon: Receipt },
    { id: 'target' as const, step: locale === 'en' ? '2' : '٢', title: locale === 'en' ? 'Target Audience' : 'الاستهداف', icon: Target },
    { id: 'review' as const, step: locale === 'en' ? '3' : '٣', title: locale === 'en' ? 'Review & Issue' : 'المراجعة', icon: ClipboardList },
  ];

  const targetHints = {
    ALL_CITIZENS: locale === 'en' ? 'Bill every registered citizen in the municipality' : 'مطالبة لكل مواطن مسجّل في البلدية',
    BUILDING_CATEGORY: locale === 'en' ? 'Citizens who registered a specific property category' : 'المواطنون الذين سجّلوا عقاراً من نوع محدّد',
    INDIVIDUAL_CITIZEN: locale === 'en' ? 'Single citizen by name or reference number' : 'مواطن واحد بالاسم أو بالرقم المرجعي',
  };

  useEffect(() => {
    if (open) {
      setValues(EMPTY);
      setCitizenQuery('');
      setStepIndex(0);
    }
  }, [open]);

  /**
   * A failed submit sends the clerk back to المراجعة.
   *
   * Without this a server rejection ("مبلغ كبير جداً") would be shown under
   * whichever step they had since navigated to, describing a field that is not
   * on screen.
   */
  useEffect(() => {
    if (error) setStepIndex(steps.length - 1);
  }, [error, steps.length]);

  const set = (patch: Partial<IssueFeeValues>) =>
    setValues((previous) => ({ ...previous, ...patch }));

  const q = citizenQuery.trim().toLowerCase();
  const digitsOnly = q.replace(/\D/g, '');
  const matches = q
    ? citizens
        .filter(
          (row) =>
            row.fullName.toLowerCase().includes(q) ||
            (row.referenceNumber ?? '').toLowerCase().includes(q) ||
            (row.phone ?? '').toLowerCase().includes(q) ||
            (digitsOnly.length > 0 && (row.phone ?? '').replace(/\D/g, '').includes(digitsOnly)) ||
            (row.whatsapp ?? '').toLowerCase().includes(q) ||
            (row.identityDocNumber ?? '').toLowerCase().includes(q) ||
            row.id.toLowerCase().includes(q),
        )
        .slice(0, 8)
    : [];

  const chosen = citizens.find((row) => row.id === values.targetCitizenId);
  const amount = Number(values.amount.replace(/\D/g, ''));
  const recurring = values.frequency !== 'ONCE';

  /**
   * Which steps are finished.
   *
   * Indexed by step so the stepper, the «التالي» guard and the final submit all
   * read the same answer — a wizard whose header says a step is done while its
   * button disagrees is worse than no header at all.
   */
  const stepComplete: Record<'details' | 'target' | 'review', boolean> = {
    details: values.title.trim().length >= 3 && amount > 0 && values.dueDate !== '',
    target:
      values.targetType !== 'INDIVIDUAL_CITIZEN' || values.targetCitizenId !== '',
    review: true,
  };

  const current = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;
  const canAdvance = stepComplete[current.id];
  const canSubmit = stepComplete.details && stepComplete.target;

  const targetSummary =
    values.targetType === 'INDIVIDUAL_CITIZEN'
      ? chosen
        ? `${chosen.fullName} — ${chosen.referenceNumber ?? '—'}`
        : '—'
      : values.targetType === 'BUILDING_CATEGORY'
        ? (locale === 'en'
            ? `Owners of ${labels.feeTargetCategory?.[values.targetCategory as never] ?? values.targetCategory}`
            : `أصحاب ${labels.feeTargetCategory?.[values.targetCategory as never] ?? values.targetCategory}`)
        : (locale === 'en' ? 'All registered citizens' : 'جميع المواطنين المسجّلين');

  const bulk = values.targetType !== 'INDIVIDUAL_CITIZEN';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={locale === 'en' ? 'Close' : 'إغلاق'}
        className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-xl"
      >
        <DialogHeader className="shrink-0 space-y-3 border-b p-6 text-start">
          <div className="space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="size-5 text-primary" aria-hidden />
              {locale === 'en' ? 'Issue New Fee' : 'إصدار رسم جديد'}
            </DialogTitle>
            <DialogDescription>
              {locale === 'en'
                ? 'Creates a fee rule and issues claims to all matching citizens.'
                : 'يُنشئ إشعاراً واحداً ويصدر مطالبة لكل مواطن مشمول به.'}
            </DialogDescription>
          </div>

          <Stepper
            index={stepIndex}
            steps={steps}
            complete={stepComplete}
            onSelect={(next) => setStepIndex(Math.min(next, stepIndex))}
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          {current.id === 'details' ? (
            <>
              <Field
                label={locale === 'en' ? 'Fee / Bill Type' : 'نوع الرسم / الفاتورة'}
                htmlFor="fee-title"
                required
              >
                <BillTypeSelect
                  id="fee-title"
                  locale={locale}
                  value={values.title}
                  onChange={(title) => set({ title })}
                  existingTitles={existingTitles}
                  placeholder={
                    locale === 'en'
                      ? 'Select from previous bills or type a new title…'
                      : 'اختر من الرسوم السابقة أو اكتب اسماً جديداً…'
                  }
                />
              </Field>

              <div className="grid gap-5">
                <Field
                  label={
                    values.basis === 'FLAT'
                      ? (locale === 'en' ? 'Amount (LBP)' : 'المبلغ بالليرة اللبنانية')
                      : values.basis === 'PER_AREA'
                        ? (locale === 'en' ? 'Rate per m² (LBP)' : 'السعر للمتر المربع (ل.ل.)')
                        : (locale === 'en' ? 'Rate per unit (LBP)' : 'السعر لكل وحدة (ل.ل.)')
                  }
                  htmlFor="fee-amount"
                  required
                >
                  <Input
                    id="fee-amount"
                    inputMode="numeric"
                    dir="ltr"
                    className="text-start text-lg font-semibold tabular-nums"
                    placeholder="500,000"
                    value={values.amount}
                    onChange={(event) => set({ amount: formatLbp(event.target.value) })}
                  />
                </Field>

                <Field
                  label={locale === 'en' ? 'Charged' : 'طريقة الاحتساب'}
                  htmlFor="fee-basis"
                  required
                >
                  <Select
                    value={values.basis}
                    onValueChange={(next) => set({ basis: next as FeeBasis })}
                  >
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

                {/*
                  Hidden under FLAT, where it decides nothing.

                  A flat notice charges its amount to everyone it targets and
                  never asks the register what they hold, so there is no unit
                  for a bearer rule to include or exclude. Showing the control
                  there would offer a clerk a lever that does not move — and the
                  value is preserved rather than reset, so a notice toggled to
                  FLAT and back does not quietly lose the choice on the way.

                  Two cards rather than a dropdown because this is the sentence
                  that decides who in the town pays. A `Select` shows one option
                  and hides the other behind a click; the whole difficulty here
                  is that «الشاغل» and «المالك» sound interchangeable until you
                  read what each does, so both descriptions are on screen at the
                  moment of choosing.
                */}
                {values.basis === 'FLAT' ? null : (
                  // Spans the row: two cards each carrying a sentence do not fit
                  // in half a dialog, and the sentences are the whole point.
                  <div>
                  <Field
                    label={locale === 'en' ? 'Levied on' : 'الرسم مترتّب على'}
                    htmlFor="fee-bearer"
                    required
                  >
                    <div id="fee-bearer" className="grid gap-2 sm:grid-cols-2">
                      {FEE_BEARER.map((option) => {
                        const selected = values.bearer === option;
                        const Icon = BEARER_ICON[option];

                        return (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => set({ bearer: option })}
                            className={cn(
                              'flex flex-col gap-1.5 rounded-lg border p-3 text-start transition-colors',
                              selected
                                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                                : 'border-border/70 bg-card hover:bg-muted/40',
                            )}
                          >
                            <span
                              className={cn(
                                'inline-flex items-center gap-1.5 text-sm font-semibold',
                                selected ? 'text-primary' : 'text-foreground',
                              )}
                            >
                              <Icon className="size-4 shrink-0" aria-hidden />
                              {labels.feeBearer[option]}
                            </span>
                            <span className="text-[11px] leading-relaxed text-muted-foreground">
                              {labels.feeBearerHint[option]}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  </div>
                )}

                <Field
                  label={locale === 'en' ? 'Due Date' : 'تاريخ الاستحقاق'}
                  htmlFor="fee-due"
                  required
                >
                  <Input
                    id="fee-due"
                    type="date"
                    dir="ltr"
                    className="text-start"
                    value={values.dueDate}
                    onChange={(event) => set({ dueDate: event.target.value })}
                  />
                </Field>
              </div>

              <Field
                label={locale === 'en' ? 'Frequency' : 'الدورية'}
                htmlFor="fee-frequency"
                required
              >
                <Select
                  value={values.frequency}
                  onValueChange={(next) => set({ frequency: next })}
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
            </>
          ) : null}

          {current.id === 'target' ? (
            <>
              <Field
                label={locale === 'en' ? 'Target Audience' : 'الفئة المستهدفة'}
                htmlFor="fee-target"
                required
              >
                <div className="grid gap-3">
                  {FEE_TARGET_TYPE.map((option) => (
                    <ChoiceCard
                      key={option}
                      name="fee-target"
                      value={option}
                      checked={values.targetType === option}
                      onChange={(next) => set({ targetType: next, targetCitizenId: '' })}
                      title={labels.feeTargetType[option]}
                      description={targetHints[option]}
                      icon={TARGET_ICON[option]}
                    />
                  ))}
                </div>
              </Field>

              {values.targetType === 'BUILDING_CATEGORY' ? (
                <Field
                  label={locale === 'en' ? 'Property Category' : 'نوع العقارات'}
                  htmlFor="fee-category"
                  required
                >
                  <Select
                    value={values.targetCategory}
                    onValueChange={(next) => set({ targetCategory: next })}
                  >
                    <SelectTrigger id="fee-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEE_TARGET_CATEGORY.map((option) => (
                        <SelectItem key={option} value={option}>
                          {labels.feeTargetCategory[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              {values.targetType === 'INDIVIDUAL_CITIZEN' ? (
                <Field
                  label={locale === 'en' ? 'Citizen' : 'المواطن'}
                  htmlFor="fee-citizen"
                  required
                >
                  <div className="space-y-2">
                    <Input
                      id="fee-citizen"
                      placeholder={locale === 'en' ? 'Citizen name or reference number' : 'اسم المواطن أو الرقم المرجعي'}
                      value={
                        chosen ? `${chosen.fullName} — ${chosen.referenceNumber}` : citizenQuery
                      }
                      onChange={(event) => {
                        setCitizenQuery(event.target.value);
                        if (values.targetCitizenId) set({ targetCitizenId: '' });
                      }}
                    />
                    {!chosen && matches.length > 0 ? (
                      <ul className="overflow-hidden rounded-lg border">
                        {matches.map((row) => (
                          <li key={row.id}>
                            <button
                              type="button"
                              onClick={() => {
                                set({ targetCitizenId: row.id });
                                setCitizenQuery('');
                              }}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm transition-colors hover:bg-accent"
                            >
                              <span className="font-medium">{row.fullName}</span>
                              <span
                                className="font-mono text-xs text-muted-foreground"
                                dir="ltr"
                              >
                                {row.referenceNumber}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </Field>
              ) : null}

              <Field
                label={locale === 'en' ? 'Payment Instructions / Notes' : 'تعليمات الدفع / ملاحظات'}
                htmlFor="fee-instructions"
              >
                <Textarea
                  id="fee-instructions"
                  rows={3}
                  value={values.instructions}
                  onChange={(event) => set({ instructions: event.target.value })}
                />
              </Field>
            </>
          ) : null}

          {current.id === 'review' ? (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <p className="text-sm text-muted-foreground">{values.title || '—'}</p>
                <p className="mt-1 text-3xl font-bold tabular-nums" dir="ltr">
                  {amount ? amount.toLocaleString('en-US') : '—'}
                  <span className="ms-2 text-base font-medium text-muted-foreground">
                    {locale === 'en' ? 'LBP' : 'ل.ل'}
                  </span>
                </p>
              </div>

              <dl className="divide-y rounded-lg border text-sm">
                <ReviewRow
                  icon={Target}
                  label={locale === 'en' ? 'Applies To' : 'يُطبَّق على'}
                  value={targetSummary}
                />
                <ReviewRow
                  icon={CalendarClock}
                  label={locale === 'en' ? 'Frequency' : 'الدورية'}
                  value={
                    recurring
                      ? `${labels.feeFrequency[values.frequency as never]} — ${locale === 'en' ? 'Repeats automatically until stopped' : 'يتكرّر تلقائياً حتى الإيقاف'}`
                      : labels.feeFrequency[values.frequency as never]
                  }
                />
                <ReviewRow
                  icon={CalendarClock}
                  label={locale === 'en' ? 'Due Date' : 'تاريخ الاستحقاق'}
                  value={
                    values.dueDate
                      ? formatDate(values.dueDate)
                      : '—'
                  }
                />
                {values.instructions.trim() ? (
                  <ReviewRow
                    icon={ClipboardList}
                    label={locale === 'en' ? 'Payment Instructions' : 'تعليمات الدفع'}
                    value={values.instructions.trim()}
                  />
                ) : null}
              </dl>

              {bulk ? (
                <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <span>
                    {locale === 'en'
                      ? 'A separate claim will be created for each included citizen and will appear immediately on their file.'
                      : 'سيتم إنشاء مطالبة منفصلة لكل مواطن مشمول، وتظهر فوراً في حسابه.'}
                    {recurring
                      ? (locale === 'en'
                          ? ' Recurrence can be cancelled later, but issued claims will remain active.'
                          : ' يمكن إيقاف التكرار لاحقاً، لكن المطالبات الصادرة تبقى قائمة.')
                      : ''}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t p-6 sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => (stepIndex === 0 ? onOpenChange(false) : setStepIndex(stepIndex - 1))}
            disabled={submitting}
          >
            {stepIndex === 0 ? (
              (locale === 'en' ? 'Cancel' : 'إلغاء')
            ) : (
              <>
                <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
                {locale === 'en' ? 'Back' : 'السابق'}
              </>
            )}
          </Button>

          {isLast ? (
            <Button disabled={!canSubmit || submitting} onClick={() => onSubmit(values)}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Check className="size-4" aria-hidden />
              )}
              {locale === 'en' ? 'Issue Claims' : 'إصدار المطالبات'}
            </Button>
          ) : (
            <Button disabled={!canAdvance} onClick={() => setStepIndex(stepIndex + 1)}>
              {locale === 'en' ? 'Next' : 'التالي'}
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stepper({
  index,
  steps,
  complete,
  onSelect,
}: {
  index: number;
  steps: Array<{ id: 'details' | 'target' | 'review'; step: string; title: string }>;
  complete: Record<'details' | 'target' | 'review', boolean>;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex items-center gap-1" aria-label="Fee issuance steps">
      {steps.map((step, position) => {
        const isActive = position === index;
        const behind = position < index;
        const done = behind && complete[step.id];

        return (
          <li key={step.id} className="flex flex-1 items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(position)}
              disabled={position > index}
              aria-current={isActive ? 'step' : undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors',
                position <= index ? 'hover:bg-accent' : 'cursor-default',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1',
                  isActive
                    ? 'bg-primary text-primary-foreground ring-primary'
                    : done
                      ? 'bg-success/10 text-success ring-success/40'
                      : behind
                        ? 'bg-destructive/10 text-destructive ring-destructive/40'
                        : 'bg-muted text-muted-foreground ring-border',
                )}
              >
                {done ? <Check className="size-3.5" /> : step.step}
              </span>
              <span
                className={cn(
                  'truncate font-medium',
                  isActive ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {step.title}
              </span>
            </button>
            {position < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn('h-px w-4 shrink-0', behind ? 'bg-primary/40' : 'bg-border')}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-end font-medium">{value}</dd>
    </div>
  );
}
