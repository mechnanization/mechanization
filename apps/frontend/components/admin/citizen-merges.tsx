'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { GitMerge, Loader2, Search, Undo2 } from 'lucide-react';
import type { CitizenMergeRecord, CitizenMergeResult, CitizenUnmergePreview } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getCitizenMerges,
  listCitizens,
  logApiError,
  previewCitizenUnmerge,
  undoCitizenMerge,
  type CitizenListItem,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
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
import { Textarea } from '@/components/ui/textarea';
import { MergeCitizensDialog } from './merge-citizens-dialog';

/**
 * «دمج ملفين» as a citizen's page shows it.
 *
 * Three things, all read from `GET /citizens/:id/merges`:
 *
 *  - on a file folded into another, a notice saying so with a link to the file
 *    that stays — a clerk who reaches a merged record by an old reference
 *    number has to be sent to the live one, not left reading a dead file;
 *  - on a file others were folded into, which ones, by whom and why;
 *  - for an administrator, «التراجع عن الدمج» on either, which the server
 *    refuses once either file has changed since.
 */
export function useCitizenMerges(tenant: string, token: string | null, citizenId: string) {
  const [merges, setMerges] = useState<{ into: CitizenMergeRecord | null; from: CitizenMergeRecord[] } | null>(null);
  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setMerges(await getCitizenMerges(tenant, token, citizenId));
    } catch (caught) {
      // A page without its merge notes is still the page; the notes are context.
      logApiError(caught);
    }
  }, [tenant, token, citizenId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { merges, reload };
}

export function CitizenMergeNotes({
  merges,
  citizenId,
  base,
  tenant,
  token,
  locale,
  canMerge,
  onChanged,
}: {
  merges: { into: CitizenMergeRecord | null; from: CitizenMergeRecord[] } | null;
  citizenId: string;
  base: string;
  tenant: string;
  token: string | null;
  locale: string;
  canMerge: boolean;
  onChanged: () => void;
}): React.JSX.Element | null {
  const en = locale === 'en';
  const [undoing, setUndoing] = useState<CitizenMergeRecord | null>(null);
  if (!merges) return null;

  const live = merges.from.filter((merge) => !merge.undoneAt);
  if (!merges.into && live.length === 0) return null;

  const fileLink = (person: CitizenMergeRecord['survivor']) => (
    <Link href={`${base}/citizens/${encodeURIComponent(person.id)}`} className="font-semibold underline underline-offset-2">
      {person.fullName}
      {person.referenceNumber ? (
        <span dir="ltr" className="font-normal">
          {' '}
          ({person.referenceNumber})
        </span>
      ) : null}
    </Link>
  );

  const byline = (merge: CitizenMergeRecord) =>
    en
      ? ` — ${formatDate(merge.mergedAt)}${merge.mergedBy ? `, by ${merge.mergedBy}` : ''}. Reason: ${merge.reason}`
      : ` — ${formatDate(merge.mergedAt)}${merge.mergedBy ? `، بواسطة ${merge.mergedBy}` : ''}. السبب: ${merge.reason}`;

  return (
    <div className="space-y-2">
      {merges.into && merges.into.absorbed.id === citizenId ? (
        <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <GitMerge className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-1 leading-relaxed">
            {en ? 'This file was merged into ' : 'دُمج هذا الملف في ملف '}
            {fileLink(merges.into.survivor)}
            {en
              ? '. It is kept, deactivated, as the record of what was filed; everything current lives on that file.'
              : '. يبقى محفوظاً ومعطّلاً سجلاً لما سُجِّل فيه، وكل ما هو قائم صار على ذلك الملف.'}
            <span className="block text-xs text-muted-foreground">{byline(merges.into)}</span>
          </p>
          {canMerge && token ? (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setUndoing(merges.into)}>
              <Undo2 className="size-4" aria-hidden />
              {en ? 'Undo the merge' : 'التراجع عن الدمج'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {live.map((merge) => (
        <div key={merge.id} className="flex flex-wrap items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
          <GitMerge className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 leading-relaxed">
            {en ? 'Merged into this file: ' : 'دُمج في هذا الملف: '}
            {fileLink(merge.absorbed)}
            <span className="block text-xs text-muted-foreground">{byline(merge)}</span>
          </p>
          {canMerge && token ? (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setUndoing(merge)}>
              <Undo2 className="size-4" aria-hidden />
              {en ? 'Undo the merge' : 'التراجع عن الدمج'}
            </Button>
          ) : null}
        </div>
      ))}

      {undoing && token ? (
        <UndoMergeDialog
          merge={undoing}
          tenant={tenant}
          token={token}
          locale={locale}
          onClose={() => setUndoing(null)}
          onUndone={() => {
            setUndoing(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

/** «التراجع عن الدمج» — asks the server first whether it would go through. */
function UndoMergeDialog({
  merge,
  tenant,
  token,
  locale,
  onClose,
  onUndone,
}: {
  merge: CitizenMergeRecord;
  tenant: string;
  token: string;
  locale: string;
  onClose: () => void;
  onUndone: () => void;
}): React.JSX.Element {
  const en = locale === 'en';
  const [preview, setPreview] = useState<CitizenUnmergePreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    previewCitizenUnmerge(tenant, token, merge.id)
      .then(setPreview)
      .catch((caught: unknown) => {
        logApiError(caught);
        setFailure(caught instanceof ApiRequestError ? caught.message : en ? 'Could not check.' : 'تعذّر التحقق.');
      });
  }, [tenant, token, merge.id, en]);

  const run = async () => {
    // Decided synchronously: `busy` disables the button only after a re-render.
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await undoCitizenMerge(tenant, token, merge.id, reason.trim());
      onUndone();
    } catch (caught) {
      logApiError(caught);
      setFailure(caught instanceof ApiRequestError ? caught.message : en ? 'The undo failed.' : 'تعذّر التراجع.');
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  };

  const blocked = !preview || preview.blocks.length > 0;

  return (
    <Dialog open onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <DialogContent className="max-w-lg" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="size-5 text-primary" aria-hidden />
            {en ? 'Undo the merge' : 'التراجع عن الدمج'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? `${merge.absorbed.fullName} becomes a file of its own again, with exactly what it held before the merge.`
              : `يعود ${merge.absorbed.fullName} ملفاً مستقلاً، بما كان عليه تماماً قبل الدمج.`}
          </DialogDescription>
        </DialogHeader>

        {!preview && !failure ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {en ? 'Checking…' : 'جارٍ التحقق…'}
          </p>
        ) : null}

        {preview && preview.blocks.length > 0 ? (
          <ul className="list-disc space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 ps-7 text-sm">
            {preview.blocks.map((block) => (
              <li key={block.code}>{block.message}</li>
            ))}
          </ul>
        ) : null}

        {preview && preview.blocks.length === 0 ? (
          <div className="space-y-1.5 text-sm">
            <label htmlFor="unmerge-reason" className="font-medium">
              {en ? 'Why is the merge being undone?' : 'لماذا يُتراجع عن الدمج؟'}
            </label>
            <Textarea
              id="unmerge-reason"
              rows={2}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        ) : null}

        {failure ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">
            {failure}
          </p>
        ) : null}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void run()}
            disabled={blocked || busy || reason.trim().length < 10}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}
            {en ? 'Undo the merge' : 'تراجع عن الدمج'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * «دمج مع ملف آخر» — for an administrator who already knows the other file.
 *
 * Search by name, reference or phone, pick one, and the merge dialog takes over
 * with its full preview. The pick is only who to compare with; nothing is
 * decided until that dialog is confirmed.
 */
export function MergeWithAnotherButton({
  citizenId,
  tenant,
  token,
  locale,
  onMerged,
}: {
  citizenId: string;
  tenant: string;
  token: string;
  locale: string;
  onMerged: (result: CitizenMergeResult) => void;
}): React.JSX.Element {
  const en = locale === 'en';
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [other, setOther] = useState<string | null>(null);

  useEffect(() => {
    if (!picking || search.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      listCitizens(tenant, token, { search: search.trim(), limit: 8 }, controller.signal)
        .then((page) => setResults(page.items.filter((item) => item.id !== citizenId && item.isActive)))
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) logApiError(caught);
        })
        .finally(() => setSearching(false));
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [picking, search, tenant, token, citizenId]);

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setPicking(true)}
        title={en ? 'Merge with another file' : 'دمج مع ملف آخر'}
      >
        <GitMerge className="size-4" aria-hidden />
        <span className="sr-only">{en ? 'Merge with another file' : 'دمج مع ملف آخر'}</span>
      </Button>

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-w-lg" closeLabel={en ? 'Cancel' : 'إلغاء'}>
          <DialogHeader>
            <DialogTitle>{en ? 'Merge with another file' : 'دمج مع ملف آخر'}</DialogTitle>
            <DialogDescription>
              {en
                ? 'Find the other file of the same person. The next step shows everything the merge would do before anything happens.'
                : 'ابحث عن الملف الآخر للشخص نفسه. الخطوة التالية تعرض كل ما سيفعله الدمج قبل أن يحدث أي شيء.'}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={en ? 'Name, reference or phone' : 'الاسم أو الرقم المرجعي أو الهاتف'}
              className="ps-8"
            />
          </div>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {searching ? (
              <li className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {en ? 'Searching…' : 'جارٍ البحث…'}
              </li>
            ) : null}
            {results.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicking(false);
                    setOther(item.id);
                  }}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border p-2 text-start text-sm hover:bg-muted/50"
                >
                  <span className="font-medium">{item.fullName}</span>
                  {item.motherName ? (
                    <span className="text-xs text-muted-foreground">
                      {en ? `mother: ${item.motherName}` : `والدته: ${item.motherName}`}
                    </span>
                  ) : null}
                  <span dir="ltr" className="text-xs text-muted-foreground">
                    {item.referenceNumber ?? ''}
                    {item.phone ? ` · ${item.phone}` : ''}
                  </span>
                </button>
              </li>
            ))}
            {!searching && search.trim().length >= 2 && results.length === 0 ? (
              <li className="p-2 text-sm text-muted-foreground">{en ? 'No active file found.' : 'لا يوجد ملف نشط مطابق.'}</li>
            ) : null}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPicking(false)}>
              {en ? 'Cancel' : 'إلغاء'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {other ? (
        <MergeCitizensDialog
          open
          onOpenChange={(next) => (next ? undefined : setOther(null))}
          tenant={tenant}
          token={token}
          locale={locale}
          firstId={citizenId}
          secondId={other}
          onMerged={(result) => {
            setOther(null);
            onMerged(result);
          }}
        />
      ) : null}
    </>
  );
}
