'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, FileSearch, Loader2, Save, Send } from 'lucide-react';
import {
  ARREARS_TEMPLATE_COLUMNS,
  submitArrearsBatchSchema,
  type ArrearsImportResult,
  type ArrearsTemplateCells,
} from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import { importArrears, submitArrearsBatch } from '@/lib/arrears-api';
import { dropsOf, reconciles, undecidedLines, writeBlocker, type LineDecision } from '@/lib/arrears';
import { parseArrearsCsv } from '@/lib/csv';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { Textarea } from '@/components/ui/textarea';
import { ArrearsVerdicts } from './arrears-verdicts';

/**
 * The import of one DRAFT batch (old-debts-plan §4.3, task 7), in the citizen
 * import's three moves: the file is read in the browser (`parseArrearsCsv`),
 * checked by the server without writing (`dryRun`), and only then written into
 * the draft. Nothing here reaches a citizen: a draft is seen by staff alone.
 *
 * Between the check and the write the accountant keeps or drops every flagged
 * line (`needsDecision`); the drops travel with both, so what the write does is
 * what the last check showed. Then the reconcile panel: the file's sum against
 * the total he added up by hand from the pages copied, to the cent, before
 * «إرسال للاعتماد» is live.
 */
export function ArrearsImportPanel({
  tenant,
  token,
  locale,
  batchId,
  onChanged,
}: {
  tenant: string;
  token: string | null;
  locale: string;
  batchId: string;
  /** After a write or a submit: the page re-reads its batch list. */
  onChanged: () => void;
}) {
  const t = useTranslations('arrears.import');
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ArrearsTemplateCells[]>([]);
  const [missingColumns, setMissingColumns] = useState<string[]>([]);
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([]);
  const [result, setResult] = useState<ArrearsImportResult | null>(null);
  const [decisions, setDecisions] = useState<Map<string, LineDecision>>(new Map());
  const [written, setWritten] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [controlTotal, setControlTotal] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [busy, setBusy] = useState<'check' | 'write' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const readFile = async (file: File) => {
    setError(null);
    setResult(null);
    setWritten(false);
    setDecisions(new Map());
    try {
      const parsed = parseArrearsCsv(await file.text());
      setFileName(file.name);
      setRows(parsed.rows);
      setMissingColumns(parsed.missingColumns);
      setUnknownHeaders(parsed.unknownHeaders);
      if (parsed.rows.length === 0) setError(t('noRows'));
    } catch {
      setError(t('unreadable'));
    }
  };

  const onDecide = useCallback((key: string, decision: LineDecision | null) => {
    setDecisions((current) => {
      const next = new Map(current);
      if (decision) next.set(key, decision);
      else next.delete(key);
      return next;
    });
    // A changed decision is not what the draft holds: save again before submitting.
    setWritten(false);
  }, []);

  const send = async (dryRun: boolean) => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setBusy(dryRun ? 'check' : 'write');
    setError(null);
    try {
      const answer = await importArrears(tenant, token, batchId, {
        rows,
        startRow: 1,
        drops: result ? dropsOf(result.lines, decisions) : [],
        dryRun,
      });
      setResult(answer);
      if (!dryRun) {
        setWritten(true);
        onChanged();
      }
    } catch (caught) {
      logApiError(caught);
      // A write refused for its rows carries the verdicts: shown, so the refusal names its lines.
      if (caught instanceof ApiRequestError && caught.code === 'ARREARS_IMPORT_HAS_REFUSED_ROWS') {
        const details = caught.payload.details as ArrearsImportResult | undefined;
        if (details?.lines) setResult(details);
      }
      setError(caught instanceof ApiRequestError ? caught.message : t('failed'));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const typedTotal = controlTotal.trim() === '' ? null : Number(controlTotal.replace(/,/g, ''));
  const submitInput = submitArrearsBatchSchema.safeParse({
    controlTotal: typedTotal,
    ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}),
  });
  const balanced = result ? reconciles(result.totals.fileTotal, Number.isFinite(typedTotal) ? typedTotal : null) : false;

  const submit = async () => {
    if (!token || !submitInput.success || !balanced || inFlight.current) return;
    inFlight.current = true;
    setBusy('submit');
    setError(null);
    try {
      await submitArrearsBatch(tenant, token, batchId, submitInput.data);
      setSubmitted(true);
      onChanged();
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof ApiRequestError ? caught.message : t('submitFailed'));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const blocker = result ? writeBlocker(result, decisions) : null;
  const undecided = result ? undecidedLines(result.lines, decisions).length : 0;
  const lbp = (amount: number) => <Money amount={amount} currency="LBP" locale={locale} exact wrap />;

  if (submitted) {
    return (
      <Alert variant="success" icon={CheckCircle2}>
        {t('submitted')}
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive" live="alert">
          {error}
        </Alert>
      ) : null}

      <Card>
        <CardContent className="space-y-4 p-5">
          <h2 className="text-base font-semibold">{t('fileTitle')}</h2>
          <FileInput
            id="arrears-file"
            accept=".csv,text/csv"
            label={fileName ?? t('choose')}
            hint={t('fileHint')}
            disabled={busy !== null}
            onSelect={(files) => {
              if (files[0]) void readFile(files[0]);
            }}
          />
          {missingColumns.length > 0 ? (
            <Alert variant="destructive">{t('missingColumns', { columns: missingColumns.join('، ') })}</Alert>
          ) : null}
          {unknownHeaders.length > 0 ? (
            <Alert variant="warning">{t('unknownHeaders', { headers: unknownHeaders.join('، ') })}</Alert>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{t('columnsReference')}</summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {ARREARS_TEMPLATE_COLUMNS.map((column) => (
                <li key={column.key}>
                  <span className="font-medium text-foreground">{column.header}</span>: {column.hint}
                </li>
              ))}
            </ul>
          </details>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant={result ? 'outline' : 'default'}
              onClick={() => void send(true)}
              disabled={!token || rows.length === 0 || missingColumns.length > 0 || busy !== null}
            >
              {busy === 'check' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FileSearch className="size-4" aria-hidden />}
              {result ? t('recheck') : t('check')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result ? (
        <>
          <StatStrip>
            <StatItem label={t('kept', { count: result.totals.kept.count })} value={lbp(result.totals.kept.amount)} />
            <StatItem
              label={t('dropped', { count: result.totals.dropped.count })}
              value={lbp(result.totals.dropped.amount)}
              hint={t('prescribedHint', { count: result.totals.prescribed.count })}
            />
            <StatItem label={t('unmatched', { count: result.totals.unmatched.count })} value={lbp(result.totals.unmatched.amount)} />
            <StatItem label={t('refused')} value={result.totals.refused.count.toLocaleString('en-US')} />
            <StatItem
              label={t('coverage')}
              value={t('coverageValue', { checked: result.coverage.withLines + result.coverage.checkedNothingOwed, total: result.coverage.citizens })}
              hint={t('coverageHint', { notInFile: result.coverage.notInFile })}
            />
          </StatStrip>

          {result.cutoffYear === null ? <Alert variant="destructive">{t('cutoffNotSet')}</Alert> : null}
          <p className="text-sm text-muted-foreground">
            {result.cutoffYear !== null ? t('cutoff', { cutoff: result.cutoffYear, oldest: result.oldestKeptYear }) : null}
          </p>

          <ArrearsVerdicts
            lines={result.lines}
            locale={locale}
            decisions={decisions}
            onDecide={onDecide}
            disabled={busy !== null}
          />

          <div className="flex flex-wrap items-center justify-end gap-3">
            {blocker ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t(`blocked.${blocker}`, { count: undecided })}
              </p>
            ) : null}
            {written ? (
              <p className="text-sm text-success" role="status">
                {t('written', { count: result.written ?? 0 })}
              </p>
            ) : null}
            <Button onClick={() => void send(false)} disabled={!token || blocker !== null || busy !== null || written}>
              {busy === 'write' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
              {t('write')}
            </Button>
          </div>

          {written ? (
            <Card>
              <CardContent className="space-y-4 p-5">
                <h2 className="text-base font-semibold">{t('reconcileTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('reconcileBody')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('fileTotal')} htmlFor="arrears-file-total">
                    <p id="arrears-file-total" className="text-lg font-semibold">
                      {lbp(result.totals.fileTotal)}
                    </p>
                  </Field>
                  <Field
                    label={t('controlTotal')}
                    htmlFor="arrears-control-total"
                    required
                    error={typedTotal !== null && !balanced ? t('notBalanced') : undefined}
                  >
                    <Input
                      id="arrears-control-total"
                      inputMode="decimal"
                      dir="ltr"
                      value={controlTotal}
                      onChange={(event) => setControlTotal(event.target.value)}
                    />
                  </Field>
                </div>
                <Field label={t('sourceNote')} htmlFor="arrears-source-note">
                  <Textarea
                    id="arrears-source-note"
                    rows={2}
                    maxLength={500}
                    placeholder={t('sourceNotePlaceholder')}
                    value={sourceNote}
                    onChange={(event) => setSourceNote(event.target.value)}
                  />
                </Field>
                <div className="flex justify-end">
                  <Button onClick={() => void submit()} disabled={!balanced || !submitInput.success || busy !== null}>
                    {busy === 'submit' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                    {t('submit')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
