'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  FileSpreadsheet,
  Loader2,
  TriangleAlert,
  Upload,
  Users,
  XCircle,
} from 'lucide-react';
import { IMPORT_COLUMNS } from '@mechanization/shared-schemas';
import type { CitizenImportResult, ImportRow } from '@mechanization/shared-schemas';
import { buildCitizenTemplate, downloadCsv, parseCitizenCsv } from '@/lib/csv';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const STEPS = [
  { id: 'file', step: '١', title: 'الملف', icon: Upload },
  { id: 'review', step: '٢', title: 'المراجعة', icon: ClipboardList },
  { id: 'result', step: '٣', title: 'النتيجة', icon: CheckCircle2 },
] as const;

/**
 * استيراد المواطنين من ملف — the municipality's existing register, in one go.
 *
 * Three steps because the middle one is the point. An import that writes on
 * upload gives a clerk no moment to discover that a column was mis-headed or
 * that half the file uses a spelling of «مطلّق» the system did not expect —
 * they find out afterwards, from a register that now holds ninety good records
 * and eleven bad ones. The review step runs the *server's* validation with
 * `dryRun`, so what it reports is what the write would do, and nothing is
 * created until the clerk has seen the failures and decided.
 */
export function ImportCitizensDialog({
  open,
  onOpenChange,
  onImport,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the import (or the dry run) against the server, one batch at a time. */
  onImport: (input: {
    rows: ImportRow[];
    dryRun: boolean;
    onProgress?: (done: number, total: number) => void;
  }) => Promise<CitizenImportResult>;
  /** Called once rows have actually been written, so the registry can reload. */
  onDone: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([]);
  const [missingColumns, setMissingColumns] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [preview, setPreview] = useState<CitizenImportResult | null>(null);
  const [outcome, setOutcome] = useState<CitizenImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    setFileName(null);
    setRows([]);
    setUnknownHeaders([]);
    setMissingColumns([]);
    setParseError(null);
    setPreview(null);
    setOutcome(null);
    setError(null);
    setProgress(null);
  }, [open]);

  async function readFile(file: File) {
    setParseError(null);
    setPreview(null);
    setError(null);
    try {
      const parsed = parseCitizenCsv(await file.text());
      setFileName(file.name);
      setRows(parsed.rows);
      setUnknownHeaders(parsed.unknownHeaders);
      setMissingColumns(parsed.missingColumns);
      if (parsed.rows.length === 0) setParseError('لم يُعثر على أي صف بيانات في الملف.');
    } catch {
      setParseError('تعذّرت قراءة الملف — تأكّد أنه بصيغة CSV.');
    }
  }

  /** Step 1 → 2: ask the server what would happen, without writing. */
  async function check() {
    setChecking(true);
    setProgress({ done: 0, total: rows.length });
    setError(null);
    try {
      setPreview(
        await onImport({
          rows,
          dryRun: true,
          onProgress: (done, total) => setProgress({ done, total }),
        }),
      );
      setStepIndex(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر فحص الملف.');
    } finally {
      setChecking(false);
    }
  }

  /**
   * Step 2 → 3: write.
   *
   * Sends **every** row, not just the ones the dry run passed. Filtering here
   * looked tidier and was wrong: rows travel in batches numbered by their
   * position in the file, so removing the failures mid-file shifts every later
   * row's number and the final report starts blaming the wrong lines. The
   * server validates each row again — deterministically, by the same schema —
   * and simply creates nothing for the ones that fail, so the outcome lists
   * every row of the file against what actually happened to it.
   */
  async function run() {
    setImporting(true);
    setProgress({ done: 0, total: rows.length });
    setError(null);
    try {
      setOutcome(
        await onImport({
          rows,
          dryRun: false,
          onProgress: (done, total) => setProgress({ done, total }),
        }),
      );
      setStepIndex(2);
      onDone();
    } catch (caught) {
      // A batch that throws has still written the batches before it, so the
      // registry is reloaded either way rather than left looking unchanged.
      onDone();
      setError(
        caught instanceof Error
          ? `${caught.message} — أعد فحص الملف لمعرفة ما تم استيراده.`
          : 'تعذّر تنفيذ الاستيراد.',
      );
    } finally {
      setImporting(false);
    }
  }

  const current = STEPS[stepIndex];
  const blocked = missingColumns.length > 0 || rows.length === 0;
  const okCount = preview?.results.filter((result) => result.ok).length ?? 0;
  const badRows = preview?.results.filter((result) => !result.ok) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel="إغلاق"
        className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 space-y-3 border-b p-6 text-start">
          <div className="space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="size-5 text-primary" aria-hidden />
              استيراد المواطنين من ملف
            </DialogTitle>
            <DialogDescription>
              صف واحد لكل مواطن مع عقاره. يُفحص الملف بالكامل قبل إنشاء أي سجل.
            </DialogDescription>
          </div>

          <ol className="flex items-center gap-1" aria-label="خطوات الاستيراد">
            {STEPS.map((step, position) => {
              const isActive = position === stepIndex;
              const behind = position < stepIndex;
              return (
                <li key={step.id} className="flex flex-1 items-center gap-1">
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm">
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1',
                        isActive
                          ? 'bg-primary text-primary-foreground ring-primary'
                          : behind
                            ? 'bg-success/10 text-success ring-success/40'
                            : 'bg-muted text-muted-foreground ring-border',
                      )}
                    >
                      {behind ? <Check className="size-3.5" /> : step.step}
                    </span>
                    <span
                      className={cn(
                        'truncate font-medium',
                        isActive ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {step.title}
                    </span>
                  </div>
                  {position < STEPS.length - 1 ? (
                    <span
                      aria-hidden
                      className={cn('h-px w-4 shrink-0', behind ? 'bg-primary/40' : 'bg-border')}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          {/* A large file is sent in batches, so there is real progress to
              report — and an import that writes for two minutes behind a
              motionless spinner is one a clerk will reload halfway through. */}
          {(checking || importing) && progress ? (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {checking ? 'جارٍ فحص الصفوف…' : 'جارٍ إنشاء السجلات…'}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {progress.done} / {progress.total}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              {importing ? (
                <p className="text-xs text-muted-foreground">
                  لا تغلق النافذة — الصفوف المُنشأة تُحفظ أولاً بأول.
                </p>
              ) : null}
            </div>
          ) : null}

          {current.id === 'file' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">ابدأ من القالب</p>
                  <p className="text-xs text-muted-foreground">
                    يحتوي على الأعمدة بالترتيب الصحيح وصفّ مثال — املأه في Excel واحفظه بصيغة
                    CSV.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadCsv('قالب-استيراد-المواطنين.csv', buildCitizenTemplate())
                  }
                >
                  <Download className="size-4" aria-hidden />
                  تنزيل القالب
                </Button>
              </div>

              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  // Cleared so re-picking the *same* file after a fix still
                  // fires `change` — the value is unchanged otherwise.
                  event.target.value = '';
                }}
              />

              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:border-primary hover:bg-accent/40"
              >
                <Upload className="size-8 text-muted-foreground" aria-hidden />
                <span className="font-medium">
                  {fileName ? 'اختر ملفاً آخر' : 'اختر ملف CSV'}
                </span>
                {fileName ? (
                  <span className="text-sm text-muted-foreground">
                    {fileName} — {rows.length} صف
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">أو اسحب الملف إلى هنا</span>
                )}
              </button>

              {parseError ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {parseError}
                </p>
              ) : null}

              {missingColumns.length > 0 ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    أعمدة إلزامية غير موجودة في الملف:{' '}
                    <span className="font-semibold">{missingColumns.join('، ')}</span>
                  </span>
                </p>
              ) : null}

              {unknownHeaders.length > 0 ? (
                <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <span>
                    أعمدة غير معروفة سيتم تجاهلها:{' '}
                    <span className="font-semibold">{unknownHeaders.join('، ')}</span>
                  </span>
                </p>
              ) : null}

              <details className="rounded-lg border">
                <summary className="cursor-pointer p-3 text-sm font-medium">
                  الأعمدة المتوقّعة ({IMPORT_COLUMNS.length})
                </summary>
                <ul className="divide-y border-t text-sm">
                  {IMPORT_COLUMNS.map((column) => (
                    <li
                      key={column.key}
                      className="flex items-baseline justify-between gap-3 px-3 py-2"
                    >
                      <span className="font-medium">
                        {column.header}
                        {column.always ? (
                          <span className="ms-1 text-destructive" aria-label="إلزامي">
                            *
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{column.hint}</span>
                    </li>
                  ))}
                </ul>
              </details>

              <p className="text-xs text-muted-foreground">
                ملاحظة: صفّ «مبنى» يحمل وحدة واحدة فقط. المباني متعدّدة الوحدات تُسجَّل من نموذج
                «تسجيل مواطن جديد».
              </p>
            </>
          ) : null}

          {current.id === 'review' && preview ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-success/40 bg-success/5 p-4 text-center">
                  <p className="text-2xl font-bold tabular-nums text-success">{okCount}</p>
                  <p className="text-sm text-muted-foreground">صف جاهز للاستيراد</p>
                </div>
                <div
                  className={cn(
                    'rounded-lg border p-4 text-center',
                    badRows.length > 0
                      ? 'border-destructive/40 bg-destructive/5'
                      : 'bg-muted/30',
                  )}
                >
                  <p
                    className={cn(
                      'text-2xl font-bold tabular-nums',
                      badRows.length > 0 ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {badRows.length}
                  </p>
                  <p className="text-sm text-muted-foreground">صف به خطأ</p>
                </div>
              </div>

              {badRows.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">الصفوف التي لن تُستورد</p>
                  <ul className="divide-y overflow-hidden rounded-lg border">
                    {badRows.map((result) => (
                      <li key={result.row} className="flex items-start gap-3 p-3 text-sm">
                        <Badge variant="outline" className="shrink-0 tabular-nums">
                          صف {result.row}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          {result.name ? <p className="font-medium">{result.name}</p> : null}
                          <p className="text-destructive">
                            {result.column ? (
                              <span className="font-semibold">{result.column}: </span>
                            ) : null}
                            {result.error}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    صحّح هذه الصفوف في الملف وأعد رفعه لاستيرادها لاحقاً — المتابعة الآن تستورد
                    الصفوف السليمة فقط.
                  </p>
                </div>
              ) : (
                <p className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  كل الصفوف صالحة.
                </p>
              )}
            </>
          ) : null}

          {current.id === 'result' && outcome ? (
            <>
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <Users className="mx-auto size-8 text-success" aria-hidden />
                <p className="mt-2 text-3xl font-bold tabular-nums">{outcome.created}</p>
                <p className="text-sm text-muted-foreground">مواطن تمت إضافته إلى السجل</p>
              </div>

              {outcome.failed > 0 ? (
                <div className="space-y-2">
                  <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                    <span>
                      {outcome.failed} صف لم يُستورد رغم اجتيازه الفحص — غالباً لتكرار رقم وثيقة
                      موجود مسبقاً.
                    </span>
                  </p>
                  <ul className="divide-y overflow-hidden rounded-lg border">
                    {outcome.results
                      .filter((result) => !result.ok)
                      .map((result) => (
                        <li key={result.row} className="flex items-start gap-3 p-3 text-sm">
                          <Badge variant="outline" className="shrink-0 tabular-nums">
                            صف {result.row}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            {result.name ? <p className="font-medium">{result.name}</p> : null}
                            <p className="text-destructive">{result.error}</p>
                          </div>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t p-6 sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => (stepIndex === 0 ? onOpenChange(false) : setStepIndex(stepIndex - 1))}
            disabled={checking || importing || current.id === 'result'}
          >
            {stepIndex === 0 ? (
              'إلغاء'
            ) : (
              <>
                <ArrowRight className="size-4" aria-hidden />
                السابق
              </>
            )}
          </Button>

          {current.id === 'file' ? (
            <Button disabled={blocked || checking} onClick={() => void check()}>
              {checking ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ClipboardList className="size-4" aria-hidden />
              )}
              فحص الملف
            </Button>
          ) : null}

          {current.id === 'review' ? (
            <Button disabled={okCount === 0 || importing} onClick={() => void run()}>
              {importing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Check className="size-4" aria-hidden />
              )}
              استيراد {okCount} مواطن
            </Button>
          ) : null}

          {current.id === 'result' ? (
            <Button onClick={() => onOpenChange(false)}>
              <ArrowLeft className="size-4" aria-hidden />
              إغلاق
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
