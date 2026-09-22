'use client';

import { useCallback, useState } from 'react';
import { CheckCircle2, Map as MapIcon } from 'lucide-react';
import {
  ApiRequestError,
  importCadastre,
  logApiError,
  type CadastreImportResult,
} from '@/lib/api-client';
import type { SettingsCopy } from '@/lib/settings-i18n';
import { Alert } from '@/components/ui/alert';
import { FileDropZone } from '@/components/ui/file-upload';
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
  const [uploading, setUploading] = useState(false);  const [result, setResult] = useState<CadastreImportResult | null>(null);
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
        setUploading(false);      }
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
            <Alert tone="error">
              {error}
            </Alert>
          ) : null}

          {/*
            The hidden input, the drag state, the key handling and the busy
            treatment all live in `FileDropZone` now — four screens had their
            own copy, and the keyboard half was the part that varied.
          */}
          <FileDropZone
            accept=".geojson,application/geo+json,application/json"
            busy={uploading}
            onFile={(file) => void upload(file)}
            title={uploading ? copy.cadastre.uploading : copy.cadastre.upload}
            hint={copy.cadastre.dropHint}
            constraints={copy.cadastre.constraints}
          />

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
