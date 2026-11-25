'use client';

import type { QualityFinding } from '@/lib/quality-api';
import { BuildingCompare } from './compare/building-compare';
import { CitizenCompare } from './compare/citizen-compare';
import { CompareShell } from './compare/compare-shell';
import { comparablePairOf } from './finding-parts';

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
 *
 * ## Where each part is
 *
 * This file picks the comparison; `compare/` holds the two of them, the grid and
 * its chrome, the citizens' rows and rules, the editable cell, and
 * `useCitizenCorrection`, which is the write.
 */
export function FindingCompare({
  finding,
  tenant,
  base,
  locale,
  token,
  canEdit,
  canMerge = false,
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
  /** SUPER_ADMIN — «دمج الملفين» on a pair that is one person. */
  canMerge?: boolean;
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
      canMerge={canMerge}
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
