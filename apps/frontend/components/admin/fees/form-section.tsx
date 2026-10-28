import { useId } from 'react';

/**
 * One group of the fee wizard's fields: what it decides on the start side, the
 * fields on the end side, a rule between it and the next.
 *
 * On a page this wide a grid of equal fields reads in any order; a row per
 * question — «الرسم», «الاستحقاق والتحصيل», «حالة الوحدة» — reads in one, with
 * the reason for the fields beside them rather than in a hint under each. The
 * fields keep a readable width (`max-w-4xl`) instead of stretching to the
 * card's. Below `lg` the heading sits above its fields.
 *
 * A `role="group"` named by its heading rather than a `<fieldset>`: a legend
 * does not take part in a grid, and the group is announced the same way. Used
 * by the details and scope steps (`issue-fee-form.tsx`, `notice-scope.tsx`);
 * the parent draws the rules with `divide-y`.
 */
export function FormSection({
  title,
  description,
  required,
  action,
  children,
}: {
  title: string;
  /** One line on what the group decides; also the group's description for a screen reader. */
  description?: React.ReactNode;
  /** The `*` every required field carries (FRM-1), for a group answered as one. */
  required?: boolean;
  /** A control that acts on the whole group, such as a reset, under the description. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      className="grid grid-cols-1 gap-x-10 gap-y-4 py-6 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
    >
      {/* The action beside the heading while the row is stacked, under its description once it has a column. */}
      <div className="flex items-start justify-between gap-3 lg:block lg:space-y-2">
        <div className="min-w-0 space-y-1">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            {title}
            {required ? (
              <span className="ms-1 text-destructive" aria-hidden>
                *
              </span>
            ) : null}
          </h3>
          {description ? (
            <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="min-w-0 max-w-4xl space-y-4">{children}</div>
    </div>
  );
}
