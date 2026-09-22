'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Hash, TriangleAlert } from 'lucide-react';
import {
  ApiRequestError,
  getMunicipalitySettings,
  logApiError,
  updateMunicipalitySettings,
} from '@/lib/api-client';
import { SEQUENCE_KEYS, type SequenceKey, type SettingsCopy } from '@/lib/settings-i18n';

import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ScrollableTable, SectionSaveRow, SettingsCard } from './settings-ui';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** One document type's reference format. Strings, because these are inputs. */
interface Sequence {
  prefix: string;
  nextNumber: string;
  padding: string;
}

type NumberingSettings = Record<SequenceKey, Sequence>;

const DEFAULTS: NumberingSettings = {
  invoice: { prefix: 'MUN-INV-', nextNumber: '1001', padding: '5' },
  serviceOrder: { prefix: 'MUN-SRV-', nextNumber: '1', padding: '5' },
  permit: { prefix: 'MUN-PRM-', nextNumber: '1', padding: '5' },
  taxReceipt: { prefix: 'MUN-RCP-', nextNumber: '1', padding: '6' },
  refund: { prefix: 'MUN-REF-', nextNumber: '1', padding: '4' },
};

const MAX_PADDING = 12;

/** `MUN-INV-`, `42`, `5` → `MUN-INV-00042`. */
export function formatReference(prefix: string, value: number, padding: number): string {
  return `${prefix}${String(Math.max(value, 0)).padStart(Math.max(padding, 1), '0')}`;
}

function parseInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * تسلسل الترقيم — how each issued document gets its reference.
 *
 * Five independent counters rather than one shared one. A municipality reading
 * «كم رخصة أصدرنا هذا العام» wants the permit counter to answer it, and a single
 * sequence shared across invoices, receipts and permits answers nothing — the
 * numbers only tell you how many documents of *all* kinds were issued.
 *
 * The preview is not decoration. Prefix, counter and padding compose into a
 * string whose shape is not obvious from three separate inputs — a padding of 4
 * against a next number of 10001 silently produces a *five*-digit reference,
 * and the only way an administrator sees that before it is printed on a permit
 * is to be shown the result.
 *
 * Saved to `system_settings.numberingSequences`, a `jsonb` column, and read
 * back by this form and nothing else — no issuer allocates a number from it
 * yet. That is also why it is JSON rather than a table: the moment something
 * does allocate, this has to become a row per document type with
 * `SELECT … FOR UPDATE` around the increment, because a JSON blob cannot hand
 * two concurrent requests two different invoice numbers. Issuing one reference
 * twice is exactly what a numbering scheme exists to prevent.
 */
export function NumberingSection({
  tenant,
  token,
  copy,
}: {
  tenant: string;
  token: string;
  copy: SettingsCopy;
}) {
  const toast = useToast();

  const [sequences, setSequences] = useState<NumberingSettings>(DEFAULTS);
  const [saved, setSaved] = useState<NumberingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getMunicipalitySettings(tenant, token);
        if (cancelled) return;
        /*
         * Merged over the defaults rather than used as-is. The column is
         * nullable and its JSON was written by whatever version of this form
         * last saved — a document type added since then would otherwise arrive
         * `undefined` and turn its three controlled inputs uncontrolled.
         */
        const next = { ...DEFAULTS };
        for (const key of SEQUENCE_KEYS) {
          const stored = result.numberingSequences?.[key];
          if (stored) {
            next[key] = {
              prefix: stored.prefix,
              nextNumber: String(stored.nextNumber),
              padding: String(stored.padding),
            };
          }
        }
        setSequences(next);
        setSaved(next);
        setError(null);
      } catch (caught) {
        logApiError(caught);
        if (!cancelled) {
          setError(caught instanceof ApiRequestError ? caught.message : copy.common.loadError);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant, token, copy.common.loadError]);

  const dirty = useMemo(
    () => saved !== null && JSON.stringify(sequences) !== JSON.stringify(saved),
    [sequences, saved],
  );

  /**
   * Prefixes used by more than one sequence.
   *
   * Not an error — two sequences may legitimately share a prefix if the
   * municipality wants one visible series — but it is almost always a
   * copy-paste left unfinished, and the consequence (two different documents
   * carrying `MUN-00042`) is discovered at an inconvenient moment.
   */
  const duplicatePrefixes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const key of SEQUENCE_KEYS) {
      const prefix = sequences[key].prefix.trim().toUpperCase();
      if (!prefix) continue;
      seen.set(prefix, (seen.get(prefix) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([prefix]) => prefix));
  }, [sequences]);

  const invalid = useMemo(() => {
    const problems = new Map<SequenceKey, { next?: string; padding?: string }>();
    for (const key of SEQUENCE_KEYS) {
      const next = parseInteger(sequences[key].nextNumber);
      const padding = parseInteger(sequences[key].padding);
      const entry: { next?: string; padding?: string } = {};
      if (next === null || next < 1) entry.next = copy.numbering.invalidNext;
      if (padding === null || padding < 1 || padding > MAX_PADDING) {
        entry.padding = copy.numbering.invalidPadding;
      }
      if (entry.next || entry.padding) problems.set(key, entry);
    }
    return problems;
  }, [sequences, copy.numbering]);

  const update = useCallback(
    (key: SequenceKey, patch: Partial<Sequence>) => {
      setSequences({ ...sequences, [key]: { ...sequences[key], ...patch } });
    },
    [sequences, setSequences],
  );

  const save = useCallback(async () => {
    if (invalid.size > 0) {
      toast.error(copy.common.saveError, { description: copy.numbering.invalidNext });
      return;
    }

    setSaving(true);
    try {
      // Parsed here, once, at the boundary — the inputs hold strings so that a
      // half-typed number is representable while it is being typed.
      const payload = Object.fromEntries(
        SEQUENCE_KEYS.map((key) => [
          key,
          {
            prefix: sequences[key].prefix,
            nextNumber: Number(sequences[key].nextNumber),
            padding: Number(sequences[key].padding),
          },
        ]),
      ) as Record<SequenceKey, { prefix: string; nextNumber: number; padding: number }>;

      await updateMunicipalitySettings(tenant, token, { numberingSequences: payload });
      setSaved(sequences);
      toast.success(copy.common.saved);
      setError(null);
    } catch (caught) {
      logApiError(caught);
      const message = caught instanceof ApiRequestError ? caught.message : copy.common.saveError;
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [tenant, token, invalid, sequences, toast, copy]);

  if (loading) {
    return <Skeleton className="h-[28rem] rounded-lg" />;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert tone="error">
          {error}
        </Alert>
      ) : null}

      {/*
        A table, as in Solar, rather than the five stacked cards this replaces.
        Five rows differing only in their prefix and counter are a table by
        nature — the reason to look at this screen is to compare the sequences
        against each other, and a column of cards makes the reader hold each
        prefix in their head to do it.
      */}
      <SettingsCard
        icon={Hash}
        title={copy.numbering.heading}
        hint={copy.numbering.hint}
        bodyClassName="p-0 sm:p-0"
      >
        <ScrollableTable minWidth="52rem">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="ps-4 sm:ps-5">{copy.numbering.document}</TableHead>
                <TableHead>{copy.numbering.prefix}</TableHead>
                <TableHead>{copy.numbering.nextNumber}</TableHead>
                <TableHead>{copy.numbering.padding}</TableHead>
                <TableHead className="pe-4 sm:pe-5">{copy.numbering.preview}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SEQUENCE_KEYS.map((key) => {
                const sequence = sequences[key];
                const problems = invalid.get(key);
                const next = parseInteger(sequence.nextNumber);
                const padding = parseInteger(sequence.padding);
                const previewable = next !== null && padding !== null && padding >= 1;
                const duplicate = duplicatePrefixes.has(sequence.prefix.trim().toUpperCase());

                return (
                  <TableRow key={key}>
                    <TableCell className="ps-4 align-top sm:ps-5">
                      <div className="flex items-start gap-2">
                        <FileText className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <div className="min-w-0">
                          <p className="font-medium">{copy.numbering.documents[key]}</p>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {copy.numbering.documentHints[key]}
                          </p>
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="align-top">
                      <Input
                        aria-label={`${copy.numbering.documents[key]} — ${copy.numbering.prefix}`}
                        dir="ltr"
                        className="w-32 text-start font-mono"
                        value={sequence.prefix}
                        /* Uppercased and stripped as it is typed: a reference is
                           read back against a printed document, and `mun-inv-`
                           beside `MUN-INV-` is a difference a clerk should never
                           have to notice. */
                        onChange={(e) =>
                          update(key, {
                            prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''),
                          })
                        }
                      />
                      {duplicate ? (
                        <p className="mt-1.5 flex w-32 items-start gap-1 text-xs leading-relaxed text-warning">
                          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                          {copy.numbering.collision}
                        </p>
                      ) : null}
                    </TableCell>

                    <TableCell className="align-top">
                      <Input
                        aria-label={`${copy.numbering.documents[key]} — ${copy.numbering.nextNumber}`}
                        inputMode="numeric"
                        dir="ltr"
                        invalid={Boolean(problems?.next)}
                        className="w-24 text-start font-mono"
                        value={sequence.nextNumber}
                        onChange={(e) =>
                          update(key, { nextNumber: e.target.value.replace(/\D/g, '') })
                        }
                      />
                      {problems?.next ? (
                        <p role="alert" className="mt-1.5 w-24 text-xs leading-relaxed text-destructive">
                          {problems.next}
                        </p>
                      ) : null}
                    </TableCell>

                    <TableCell className="align-top">
                      <Input
                        aria-label={`${copy.numbering.documents[key]} — ${copy.numbering.padding}`}
                        inputMode="numeric"
                        dir="ltr"
                        invalid={Boolean(problems?.padding)}
                        className="w-20 text-start font-mono"
                        value={sequence.padding}
                        onChange={(e) =>
                          update(key, { padding: e.target.value.replace(/\D/g, '').slice(0, 2) })
                        }
                      />
                      {problems?.padding ? (
                        <p role="alert" className="mt-1.5 w-24 text-xs leading-relaxed text-destructive">
                          {problems.padding}
                        </p>
                      ) : null}
                    </TableCell>

                    {/*
                      Two consecutive references, not one. A single sample looks
                      correct in every configuration; it takes the second to show
                      that a counter about to cross its padding width widens the
                      reference mid-series — the failure that gets discovered
                      after it is printed on a permit.
                    */}
                    <TableCell className="pe-4 align-top sm:pe-5">
                      {previewable ? (
                        <div className="space-y-0.5 font-mono text-sm">
                          <p className="whitespace-nowrap">
                            <bdi dir="ltr">
                              {formatReference(sequence.prefix, next, padding)}
                            </bdi>
                          </p>
                          <p className="whitespace-nowrap text-xs text-muted-foreground">
                            <bdi dir="ltr">
                              {formatReference(sequence.prefix, next + 1, padding)}
                            </bdi>
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">—</p>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollableTable>

        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <SectionSaveRow
            copy={copy}
            dirty={dirty}
            saving={saving}
            onSave={() => void save()}
            onDiscard={() => saved && setSequences(saved)}
          />
        </div>
      </SettingsCard>
    </div>
  );
}
