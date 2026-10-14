'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search, UserRound } from 'lucide-react';
import type { CitizenListItem } from '@/lib/api-client';
import { useCitizenSearch } from '@/lib/use-citizen-search';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CitizenSearchStatus } from '@/components/admin/citizen-search-status';

/** The citizen a screen is acting for: what tells two «محمد خليل»s apart, and nothing more. */
export interface PickedCitizen {
  id: string;
  fullName: string;
  motherName: string | null;
  referenceNumber: string | null;
}

/** A register row as the picker hands it on. */
export function pickedCitizen(row: CitizenListItem): PickedCitizen {
  return {
    id: row.id,
    fullName: row.fullName,
    motherName: row.motherName ?? null,
    referenceNumber: row.referenceNumber ?? null,
  };
}

/**
 * «المواطن» — the one control that finds the file a screen acts on: a fee,
 * a sale's new owner, a case's people, the other half of a merge.
 *
 * It searches the register on the server as the clerk types
 * (`useCitizenSearch`), never a page loaded up front. A row shows the name,
 * the mother's name and the رقم مرجعي — what tells two people with one name
 * apart. The identity document's number and the phone travel with the row and
 * are never drawn: a screen at a public counter is read over shoulders. Files
 * folded into another by «دمج ملفين» are never offered, and archived ones only
 * where the screen asks (`includeArchived`), marked as such.
 *
 * Controlled: `value` is the chosen file, shown as a card with «تغيير», and
 * `onChange(null)` puts the search back. A screen that adds several people
 * keeps `value` null and takes each `onChange` as one more.
 */
export function CitizenPicker({
  id,
  tenant,
  token,
  value,
  onChange,
  exclude,
  includeArchived = false,
  invalid = false,
  placeholder,
  ariaLabel,
  autoFocus = false,
}: {
  /** On the search box, so a `Field` can label it and a form can focus it. */
  id: string;
  tenant: string;
  /** The staff session's token; the search runs with it. */
  token: string | null;
  value: PickedCitizen | null;
  onChange: (citizen: PickedCitizen | null) => void;
  /** Files this screen may not offer (`useCitizenSearch`). */
  exclude?: readonly string[];
  includeArchived?: boolean;
  invalid?: boolean;
  /** What to search by, when the screen says it better than the default. */
  placeholder?: string;
  /** The search box's name where no `Field` label points at `id` (a `fieldset` legend). */
  ariaLabel?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  const t = useTranslations('citizenPicker');
  const [term, setTerm] = useState('');
  const search = useCitizenSearch(tenant, token, term, value === null, { includeArchived, exclude });
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Set by «تغيير», so the search box it brings back takes the focus. */
  const refocus = useRef(false);

  useEffect(() => {
    if (value === null && refocus.current) {
      refocus.current = false;
      inputRef.current?.focus();
    }
  }, [value]);

  if (value) {
    return (
      <div className="flex min-h-touch items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
        <UserRound className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            <bdi>{value.fullName}</bdi>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {value.motherName ? t('mother', { name: value.motherName }) : t('motherUnknown')}
            {value.referenceNumber ? (
              <>
                {' · '}
                <bdi dir="ltr" className="font-mono">
                  {value.referenceNumber}
                </bdi>
              </>
            ) : null}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            refocus.current = true;
            setTerm('');
            onChange(null);
          }}
        >
          {t('change')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          id={id}
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={placeholder ?? t('placeholder')}
          invalid={invalid}
          aria-label={ariaLabel}
          autoComplete="off"
          autoFocus={autoFocus}
          className="ps-9"
        />
      </div>

      {search.results.length > 0 ? (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label={t('results')}>
          {search.results.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => {
                  setTerm('');
                  onChange(pickedCitizen(row));
                }}
                className="flex min-h-touch w-full items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    <bdi>{row.fullName}</bdi>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.motherName ? t('mother', { name: row.motherName }) : t('motherUnknown')}
                  </span>
                </span>
                {!row.isActive ? <Badge variant="soft-muted">{t('archived')}</Badge> : null}
                {row.referenceNumber ? (
                  <bdi dir="ltr" className="shrink-0 font-mono text-xs text-muted-foreground">
                    {row.referenceNumber}
                  </bdi>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <CitizenSearchStatus term={term} search={search} archivedOffered={includeArchived} />
    </div>
  );
}
