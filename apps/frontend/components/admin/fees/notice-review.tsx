'use client';

import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CITIZEN_RESIDENCE, FEE_TARGET_CATEGORY, getLabels } from '@mechanization/shared-schemas';
import type { FeeNoticePreviewResult } from '@mechanization/shared-schemas';
import type { PickedCitizen } from '@/components/admin/citizen-picker';
import { FormSection } from '@/components/admin/fees/form-section';
import {
  PreviewBrackets,
  PreviewFigures,
  PreviewFindings,
  useNoticePreview,
  type NoticePreviewState,
} from '@/components/admin/fees/notice-preview';
import { ScopeWarnings } from '@/components/admin/fees/notice-scope';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { formatDay } from '@/lib/dates';
import { noticePayload, noticeWarnings, toMatrix, typedAmount, unitStatesOf, type NoticeDraft } from '@/lib/fee-notice-draft';

/** The steps a review row sends the clerk back to. */
export type EditableStep = 'details' | 'brackets' | 'target';

interface NoticeReviewProps {
  values: NoticeDraft;
  set: (patch: Partial<NoticeDraft>) => void;
  locale: string;
  tenant: string;
  base: string;
  token: string | null;
  /** The citizen a notice to one person names, as the picker found them. */
  chosen?: PickedCitizen;
  /** Every earlier step passes the schema: only then is the notice previewed. */
  ready: boolean;
  onPreview: (result: FeeNoticePreviewResult | null) => void;
  /** «تعديل»: back to the step that asks it. */
  onEdit: (step: EditableStep) => void;
}

/**
 * «المراجعة» — the notice read back before «إصدار», in the order it is decided
 * and then what it does:
 *
 *  - what it raises, pinned at the top while the rest is read
 *    (`PreviewFigures`);
 *  - «الرسم»: the fee as the details step set it;
 *  - «جدول الفئات», under TIERED_AREA: each bracket beside the units it counts
 *    and their subtotal (`PreviewBrackets`);
 *  - «النطاق»: who the notice reaches;
 *  - what it leaves unbilled, a row for each kind there is (`PreviewFindings`);
 *  - «قبل الإصدار»: what the clerk must know or confirm, last, beside the
 *    button it unlocks.
 *
 * Each is a row of the step's frame (`FormSection`), as on the steps before
 * it, read with `SummaryList` (PRIM-7), and each row a step decides has its
 * «تعديل», which goes back to that step. Mounted only on the review step, so
 * the preview is read afresh on every visit.
 */
export function NoticeReview(props: NoticeReviewProps) {
  return props.ready ? <ReviewWithPreview {...props} /> : <ReviewBody {...props} preview={null} />;
}

function ReviewWithPreview(props: NoticeReviewProps) {
  const { tenant, base, token, values, onPreview } = props;
  const preview = useNoticePreview({ tenant, base, token, input: noticePayload(values), onResult: onPreview });
  return <ReviewBody {...props} preview={preview} />;
}

function ReviewBody({
  values,
  set,
  locale,
  chosen,
  onEdit,
  preview,
}: NoticeReviewProps & { preview: NoticePreviewState | null }) {
  const t = useTranslations('fees.issueForm');
  const tScope = useTranslations('fees.scope');
  const labels = getLabels(locale);

  const flat = values.basis === 'FLAT';
  const tiered = values.basis === 'TIERED_AREA';
  const bulk = values.audience === 'ALL';
  const recurring = values.frequency !== 'ONCE';
  const amount = typedAmount(values.amount);
  const warnings = noticeWarnings(values);
  const separator = tScope('separator');

  const appliesTo = !bulk
    ? chosen
      ? `${chosen.fullName} — ${chosen.referenceNumber ?? '—'}`
      : '—'
    : FEE_TARGET_CATEGORY.every((category) => values.categories.includes(category))
      ? t('review.allCitizens')
      : t('review.categories', {
          categories: values.categories.map((category) => labels.feeTargetCategory[category]).join(separator),
        });
  const states = unitStatesOf(values)
    .map((state) => labels.unitStatus[state])
    .join(separator);
  const residences = CITIZEN_RESIDENCE.every((kind) => values.residences.includes(kind))
    ? t('review.allResidences')
    : values.residences.map((kind) => labels.citizenResidence[kind]).join(separator);

  /** «تعديل» on a row: named with its row for a screen reader, which hears the buttons apart. */
  const edit = (step: EditableStep, section: string) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => onEdit(step)}
      aria-label={t('review.editSection', { section })}
    >
      <Pencil className="size-3.5" aria-hidden />
      {t('review.edit')}
    </Button>
  );

  const feeTitle = t('sections.fee.title');
  const scopeTitle = t('steps.target');

  return (
    <>
      {preview ? <PreviewFigures state={preview} locale={locale} /> : null}

      <div className="divide-y">
        <FormSection title={feeTitle} action={edit('details', feeTitle)}>
          <SummaryList>
            <SummaryRow label={t('title')}>{values.title.trim() || '—'}</SummaryRow>
            <SummaryRow label={t('review.basis')}>{labels.feeBasis[values.basis]}</SummaryRow>
            {tiered ? null : (
              // The rate's unit beside it: «500,000» per m² read as a flat fee is the mistake this guards.
              <SummaryRow label={t('amount', { basis: values.basis })}>
                <span dir="ltr" className="tabular-nums">
                  {amount ? amount.toLocaleString('en-US') : '—'}
                </span>{' '}
                <span className="font-normal text-muted-foreground">
                  {t('review.rateUnit', { basis: values.basis })}
                </span>
              </SummaryRow>
            )}
            {/* The choice that changes what residents owe, read back before the last button (M1). */}
            {flat ? null : <SummaryRow label={t('review.bearer')}>{labels.feeBearer[values.bearer]}</SummaryRow>}
            <SummaryRow label={t('review.frequency')}>
              {recurring
                ? t('review.recurring', { frequency: labels.feeFrequency[values.frequency] })
                : labels.feeFrequency[values.frequency]}
            </SummaryRow>
            <SummaryRow label={t('review.dueDate')}>
              {values.dueDate ? formatDay(values.dueDate) : '—'}
            </SummaryRow>
            {values.instructions.trim() ? (
              <SummaryRow label={t('review.instructions')}>{values.instructions.trim()}</SummaryRow>
            ) : null}
          </SummaryList>
        </FormSection>

        {tiered ? (
          <PreviewBrackets
            brackets={toMatrix(values.matrixBrackets)}
            counts={preview?.result?.brackets ?? null}
            locale={locale}
            action={edit('brackets', t('review.brackets'))}
          />
        ) : null}

        <FormSection title={scopeTitle} action={edit('target', scopeTitle)}>
          <SummaryList>
            <SummaryRow label={t('review.appliesTo')}>{appliesTo}</SummaryRow>
            {/* «من يشمل الإشعار» read back: the statuses it charges, and for a notice to everyone the kinds of file. */}
            {flat ? null : <SummaryRow label={t('review.states')}>{states}</SummaryRow>}
            {bulk ? <SummaryRow label={t('review.residences')}>{residences}</SummaryRow> : null}
          </SummaryList>
        </FormSection>

        {preview?.result ? <PreviewFindings result={preview.result} locale={locale} /> : null}

        {bulk || warnings.length > 0 ? (
          <FormSection title={t('review.sections.confirm')}>
            {bulk ? (
              <Alert variant="warning">
                {/* Said per basis: under TIERED_AREA a shared unit is one bill for several people, not one each (M4). */}
                <p>{t(flat ? 'bulk.FLAT' : tiered ? 'bulk.TIERED_AREA' : 'bulk.holdings')}</p>
                {recurring ? <p className="mt-1">{t('bulk.recurring')}</p> : null}
              </Alert>
            ) : null}

            {/*
              A scope that departs from the law (0100) is said again here, and
              «إصدار» waits for the clerk to confirm it: the server refuses it
              unconfirmed too (`acknowledgedWarnings`).
            */}
            {warnings.length > 0 ? (
              <div className="space-y-2">
                <ScopeWarnings values={values} locale={locale} />
                <label
                  htmlFor="fee-confirm-scope"
                  className="flex cursor-pointer select-none items-start gap-2.5 rounded-md border border-warning/40 p-3 text-sm font-medium"
                >
                  <Checkbox
                    id="fee-confirm-scope"
                    className="mt-0.5"
                    checked={values.scopeConfirmed}
                    onCheckedChange={(next) => set({ scopeConfirmed: next === true })}
                  />
                  {t('confirmScope')}
                </label>
                {values.scopeConfirmed ? null : (
                  <p className="text-xs text-muted-foreground">{t('confirmScopeNeeded')}</p>
                )}
              </div>
            ) : null}
          </FormSection>
        ) : null}
      </div>
    </>
  );
}
