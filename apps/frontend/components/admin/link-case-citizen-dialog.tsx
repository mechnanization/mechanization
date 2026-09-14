'use client';

import { useEffect, useState } from 'react';
import { Link2, Loader2, Search, Unlink, UserRound } from 'lucide-react';
import type { CitizenListItem } from '@/lib/api-client';
import { listCitizens, logApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const SEARCH_DEBOUNCE_MS = 350;

/**
 * The bridge from a حالة to the citizen registry — search-and-pick, because
 * this is the fallback that has to work no matter *when* the citizen was
 * actually registered: right now from this same dialog's sibling action, last
 * week by a different inspector, or offline three days ago and only just
 * synced. A case logged Monday and a citizen registered Friday look identical
 * to the database unless something ties them together by hand.
 */
export function LinkCaseCitizenDialog({
  open,
  onOpenChange,
  tenant,
  token,
  currentCitizenName,
  submitting,
  error,
  onLink,
  onUnlink,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  /** Set when this case already has a linked citizen — offers Unlink instead of a fresh search. */
  currentCitizenName?: string | null;
  submitting: boolean;
  error: string | null;
  onLink: (citizen: CitizenListItem) => void;
  onUnlink: () => void;
  locale?: string;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) {
      setTerm('');
      setResults([]);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !term.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      listCitizens(tenant, token, { search: term.trim(), limit: 8 })
        .then((result) => {
          if (!cancelled) setResults(result.items);
        })
        .catch((caught) => {
          logApiError(caught);
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, term, tenant, token]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={locale === 'en' ? 'Close' : 'إغلاق'} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {locale === 'en' ? 'Link to a Citizen' : 'ربط بمواطن'}
          </DialogTitle>
          <DialogDescription>
            {locale === 'en'
              ? 'Mark this case resolved by the registration it turned into — search by name, phone or reference number.'
              : 'اربط هذه الحالة بالتسجيل الذي نتجت عنه — ابحث بالاسم أو الهاتف أو الرقم المرجعي.'}
          </DialogDescription>
        </DialogHeader>

        {currentCitizenName ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3">
            <span className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <Link2 className="size-4 shrink-0" aria-hidden />
              {locale === 'en' ? 'Linked to' : 'مرتبطة بـ'} {currentCitizenName}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              disabled={submitting}
              onClick={onUnlink}
            >
              <Unlink className="size-3.5" aria-hidden />
              {locale === 'en' ? 'Unlink' : 'إلغاء الربط'}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="relative">
          <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            className="ps-9"
            placeholder={locale === 'en' ? 'Search citizens…' : 'ابحث عن مواطن…'}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
        </div>

        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {searching ? (
            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {locale === 'en' ? 'Searching…' : 'جارٍ البحث…'}
            </p>
          ) : term.trim() && results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {locale === 'en' ? 'No matching citizens.' : 'لا يوجد مواطنون مطابقون.'}
            </p>
          ) : (
            results.map((citizen) => (
              <button
                key={citizen.id}
                type="button"
                disabled={submitting}
                onClick={() => onLink(citizen)}
                className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-card p-2.5 text-start transition-colors hover:bg-accent disabled:opacity-50"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <UserRound className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{citizen.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground text-start">
                    <bdi dir="ltr">
                      {[citizen.phone, citizen.referenceNumber].filter(Boolean).join(' — ')}
                    </bdi>
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {locale === 'en' ? 'Close' : 'إغلاق'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
