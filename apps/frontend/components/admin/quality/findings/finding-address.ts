import { QUALITY_FINDING_KIND, type QualityFindingKind } from '@mechanization/shared-schemas';
import type { UrlParam } from '@/lib/url-state';
import { param } from '@/lib/use-url-state';
import type { QualityFinding } from '@/lib/quality-api';

/** Which of the three views is on screen, and for which finding. */
export type View =
  | { mode: 'list' }
  | { mode: 'details'; key: string }
  | { mode: 'compare'; key: string };

export const keyOf = (finding: QualityFinding) => `${finding.kind}|${finding.subjectKey}`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const FINDING_KEY = new RegExp(
  `^(?:${QUALITY_FINDING_KIND.join('|')})\\|(?:${UUID}(?:,${UUID})?|queue)$`,
);

/**
 * `?finding=` — the finding «عرض التفاصيل» is open on, spelled as `keyOf`.
 *
 * Only in the shape `DataQualityService` builds today: a known kind, then one
 * row UUID, a sorted pair of them, or the owner-link `queue`. No subject key is
 * a name or a document number, and a future one that is fails this test and
 * stays out of the address (`url-state.ts`) — its detail view still opens, as
 * component state.
 *
 * Only the detail view, which reads. «الإجراء» corrects and merges records, so
 * a reload or a pasted link must never land inside it: a reload from there
 * opens the same finding's detail instead, one click from where it was.
 */
const FINDING: UrlParam<string> = {
  parse: (raw) => {
    const value = raw?.trim() ?? '';
    return FINDING_KEY.test(value) ? value : '';
  },
  serialize: (value) => (FINDING_KEY.test(value) ? value : null),
};

/** The queue's filters and the open detail view. `page`/`limit` are `useUrlPagination`'s. */
export const FINDINGS_URL = {
  kind: param.oneOf<QualityFindingKind | ''>(QUALITY_FINDING_KIND, ''),
  dismissed: param.flag(),
  finding: FINDING,
};
