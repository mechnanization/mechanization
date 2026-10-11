'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { CITIZEN_SEARCH_MIN_LENGTH, type CitizenSearchState } from '@/lib/use-citizen-search';

/**
 * The line under a citizen picker that says where its search stands: on its
 * way, found nobody, or could not reach the register. The last two are told
 * apart because a clerk who reads «no match» files a duplicate, while one who
 * reads «could not search» tries again (`useCitizenSearch`).
 */
export function CitizenSearchStatus({
  term,
  search,
}: {
  term: string;
  search: CitizenSearchState;
}): React.JSX.Element | null {
  const t = useTranslations('citizens.search');
  const trimmed = term.trim();
  if (trimmed.length < CITIZEN_SEARCH_MIN_LENGTH) return null;

  if (search.searching) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t('searching')}
      </p>
    );
  }
  if (search.searched !== trimmed) return null;
  if (search.failed) {
    return (
      <Alert variant="destructive" live="status">
        {t('failed')}
      </Alert>
    );
  }
  if (search.results.length === 0) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t('noMatches')}
      </p>
    );
  }
  return null;
}
