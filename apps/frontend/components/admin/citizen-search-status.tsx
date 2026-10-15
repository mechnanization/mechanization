'use client';

import { useTranslations } from 'next-intl';
import { Loader2, RotateCcw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CITIZEN_SEARCH_MIN_LENGTH, type CitizenSearch } from '@/lib/use-citizen-search';
import { cn } from '@/lib/utils';

/**
 * The line under a citizen picker that says where its search stands: on its
 * way, found nobody, found more than it lists, or could not search. The last
 * two of «nobody» and «could not» are told apart because a clerk who reads «no
 * match» files a duplicate, while one who reads «could not search» tries again
 * (`useCitizenSearch`).
 *
 * One `role="status"` element stays mounted and only its words change, so a
 * screen reader announces each answer, the number of files found included
 * (A11Y-5). A failure is also drawn as a warning note with the API's own words
 * and «إعادة المحاولة», as a failed read is elsewhere (`RefreshFailedAlert`);
 * that note is silent (`live="none"`), since the status line already says it.
 */
export function CitizenSearchStatus({
  term,
  search,
  archivedOffered = false,
}: {
  term: string;
  search: CitizenSearch;
  /** The search offers archived files too (`includeArchived`), so «nobody» does not leave them out. */
  archivedOffered?: boolean;
}): React.JSX.Element | null {
  const t = useTranslations('citizens.search');
  const tCommon = useTranslations('common');
  const trimmed = term.trim();
  const active = trimmed.length >= CITIZEN_SEARCH_MIN_LENGTH;
  const answered = active && !search.searching && search.searched === trimmed;
  const failure = answered && search.failed ? (search.error ?? t('failed')) : null;

  const words = !active
    ? ''
    : search.searching
      ? t('searching')
      : !answered
        ? ''
        : failure
          ? failure
          : search.results.length === 0
            ? archivedOffered
              ? t('noMatches')
              : `${t('noMatches')} ${t('archivedLeftOut')}`
            : search.more
              ? t('more', { count: search.results.length })
              : t('found', { count: search.results.length });
  // Seen: the search on its way, nobody found, more to narrow. Heard only: the count above a list in view.
  const visible = active && (search.searching || (answered && !failure && (search.results.length === 0 || search.more)));

  return (
    <>
      {failure ? (
        <Alert variant="warning" live="none">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{failure}</span>
            <Button type="button" size="sm" variant="outline" onClick={search.retry}>
              <RotateCcw className="size-4" aria-hidden />
              {tCommon('retry')}
            </Button>
          </div>
        </Alert>
      ) : null}
      <p role="status" className={cn('flex items-center gap-2 text-xs text-muted-foreground', !visible && 'sr-only')}>
        {active && search.searching ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {words}
      </p>
    </>
  );
}
