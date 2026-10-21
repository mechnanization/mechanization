'use client';

import { useCallback, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Map as MapIcon, UploadCloud } from 'lucide-react';
import {
  ApiRequestError,
  importCadastre,
  logApiError,
  type CadastreImportResult,
} from '@/lib/api-client';
import type { SettingsCopy } from '@/lib/settings-i18n';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { Notice, SettingsCard, StatusTile } from './settings-ui';
import { cn } from '@/lib/utils';

/**
 * السجل العقاري — the parcel geometry the map draws from.
 *
 * Moved here from the map screen's header. Replacing a municipality's cadastre
 * is configuration done once at setup and rarely again; sitting it beside the
 * map meant a destructive, whole-municipality import was one mis-click away
 * every time a clerk opened the map to look up an address. Settings is where
 * the things you change deliberately live.
 *
 * The import *replaces* the parcel layer rather than merging into it, which is
 * the one fact worth knowing before pressing the button — so it is stated above
 * the drop zone rather than discovered from the result.
 */
export function CadastreSection({
  tenant,
  token,
  copy,
}: {
  tenant: string;
  token: string;
  copy: SettingsCopy;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<CadastreImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      // Extension only — the server parses and validates the contents, and a
      // client-side guess about GeoJSON structure would either duplicate that
      // check or contradict it.
      if (!/\.(geojson|json)$/i.test(file.name)) {
        toast.error(copy.cadastre.wrongFormat);
        return;
      }

      setUploading(true);
      setError(null);
      setResult(null);
      try {
        const imported = await importCadastre(tenant, token, file);
        setResult(imported);
        toast.success(copy.cadastre.imported);
      } catch (caught) {
        logApiError(caught);
        const message =
          caught instanceof ApiRequestError ? caught.payload.message : copy.cadastre.failed;
        setError(message);
        toast.error(message);
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [tenant, token, toast, copy.cadastre],
  );

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={MapIcon}
        title={copy.cadastre.heading}
        hint={copy.cadastre.hint}
      >
        <div className="space-y-4">
          <Notice title={copy.cadastre.replaceWarning}>{copy.cadastre.replaceWarningWhy}</Notice>

          {error ? (
            <Alert variant="destructive" live="alert">
              {error}
            </Alert>
          ) : null}

          <input
            ref={fileInput}
            type="file"
            accept=".geojson,application/geo+json,application/json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />

          <div
            role="button"
            tabIndex={0}
            onClick={() => !uploading && fileInput.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
                e.preventDefault();
                fileInput.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file && !uploading) void upload(file);
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition',
              dragging
                ? 'border-primary/60 bg-muted/30'
                : 'border-muted-foreground/25 bg-muted/10 hover:border-primary/60 hover:bg-muted/30',
              uploading && 'pointer-events-none opacity-60',
            )}
          >
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-110">
              {uploading ? (
                <Loader2 className="size-6 animate-spin" aria-hidden />
              ) : (
                <UploadCloud className="size-6" aria-hidden />
              )}
            </div>
            <p className="text-sm">
              <span className="font-semibold group-hover:text-primary">
                {uploading ? copy.cadastre.uploading : copy.cadastre.upload}
              </span>{' '}
              {!uploading ? (
                <span className="text-muted-foreground">{copy.cadastre.dropHint}</span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">{copy.cadastre.constraints}</p>
          </div>

          {result ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <StatusTile
                label={copy.cadastre.parcelsImported}
                icon={<CheckCircle2 className="size-3.5 text-success" aria-hidden />}
              >
                <p className="font-medium tabular-nums" dir="ltr">
                  {result.parcelsImported.toLocaleString('en-US')}
                </p>
              </StatusTile>
              <StatusTile label={copy.cadastre.linesImported}>
                <p className="font-medium tabular-nums" dir="ltr">
                  {result.linesImported.toLocaleString('en-US')}
                </p>
              </StatusTile>
              {/*
                Skipped features are reported even when zero. A silent "imported
                4,000" hides that 200 more were dropped as invalid, and the
                municipality only finds the gap when a parcel it expects is not
                on the map.
              */}
              <StatusTile label={copy.cadastre.parcelsSkipped}>
                <p
                  className={cn(
                    'font-medium tabular-nums',
                    result.parcelsSkipped > 0 && 'text-warning',
                  )}
                  dir="ltr"
                >
                  {result.parcelsSkipped.toLocaleString('en-US')}
                </p>
              </StatusTile>
            </div>
          ) : null}

          {result ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="soft-success">{copy.cadastre.imported}</Badge>
              {copy.cadastre.reloadMapHint}
            </p>
          ) : null}
        </div>
      </SettingsCard>
    </div>
  );
}
