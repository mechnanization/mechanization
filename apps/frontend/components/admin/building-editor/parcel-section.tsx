'use client';

import {
  CheckCircle2,
  Hash,
  Loader2,
  X,
} from 'lucide-react';
import {
  type ParcelCorrectionResult,
  type ZoneSummary,
} from '@/lib/api-client';
import { ParcelCorrectionDialog } from '@/components/admin/parcel-correction-dialog';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StepField } from './step-field';

/**
 * «رقم العقار»: typed or read off the map, with «تصحيح رقم العقار» on a saved building.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function ParcelSection({
  en,
  editing,
  zones,
  fieldErrors,
  trimmedParcel,
  token,
  buildingId,
  savedCode,
  setCorrectingParcel,
  tenant,
  loadedUpdatedAtRef,
  correctingParcel,
  applyParcelCorrection,
  locale,
  parcelNumber,
  setParcelNumber,
  setParcelFromMap,
  parcelFromMap,
  zoneMismatch,
  parcelZone,
  cadastreHint,
  displayCode,
  resolving,
  previousCodes,
}: {
  en: boolean;
  editing: boolean;
  zones: ZoneSummary[];
  fieldErrors: Record<string, string>;
  trimmedParcel: string;
  token: string | undefined;
  buildingId: string | undefined;
  savedCode: string | null;
  setCorrectingParcel: React.Dispatch<React.SetStateAction<boolean>>;
  tenant: string;
  loadedUpdatedAtRef: React.MutableRefObject<string | null>;
  correctingParcel: boolean;
  applyParcelCorrection: (result: ParcelCorrectionResult, oldParcel: string) => void;
  locale: string;
  parcelNumber: string;
  setParcelNumber: React.Dispatch<React.SetStateAction<string>>;
  setParcelFromMap: React.Dispatch<React.SetStateAction<boolean>>;
  parcelFromMap: boolean;
  zoneMismatch: boolean;
  parcelZone: { id: string; code: string; name: string; color: string; } | null;
  cadastreHint: string | null;
  displayCode: string | null;
  resolving: boolean;
  previousCodes: { code: string; parcelNumber: string; reason: string; retiredAt: string; }[];
}): React.JSX.Element {
  return (
    <>
      {/*
        ── 3. رقم العقار ──────────────────────────────────────────

        Not a field on an existing building: the suffix was allocated
        against the parcel and the whole code derives from it, so a
        wrong number is corrected by its own action — «تصحيح رقم العقار»
        — which reallocates the code, retires the old one and carries
        every card and case that copies the parcel along with it.
        `updateBuildingSchema` does not accept the field at all.
      */}
      <StepField
        en={en}
        ordinal={!editing && zones.length > 0 ? 3 : 2}
        title={en ? 'Parcel Number (رقم العقار)' : 'رقم العقار'}
        htmlFor="building-parcel"
        required={!editing}
        error={fieldErrors.parcelNumber}
      >
        {editing ? (
          <>
            <div className="flex items-stretch gap-2">
              <p
                id="building-parcel"
                dir="ltr"
                className="flex h-10 min-w-0 flex-1 items-center rounded-md border bg-muted/40 px-3 text-start font-mono text-base font-medium text-foreground"
              >
                {trimmedParcel || '—'}
              </p>
              {token && buildingId && savedCode ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 gap-1.5"
                  onClick={() => setCorrectingParcel(true)}
                >
                  <Hash className="size-4" aria-hidden />
                  {en ? 'Correct the number' : 'تصحيح رقم العقار'}
                </Button>
              ) : null}
            </div>
            {token && buildingId && savedCode ? (
              <ParcelCorrectionDialog
                tenant={tenant}
                token={token}
                building={{
                  id: buildingId,
                  code: savedCode,
                  parcelNumber: trimmedParcel,
                  updatedAt: loadedUpdatedAtRef.current,
                }}
                open={correctingParcel}
                onOpenChange={setCorrectingParcel}
                onCorrected={(result) => applyParcelCorrection(result, trimmedParcel)}
                locale={locale}
              />
            ) : null}
          </>
        ) : (
          <div className="relative" dir="ltr">
            <Input
              id="building-parcel"
              value={parcelNumber}
              onChange={(event) => {
                setParcelNumber(event.target.value);
                // Typed over: the note must stop claiming the cadastre
                // supplied this, or a wrong number would read as the
                // survey's answer rather than as somebody's correction.
                setParcelFromMap(false);
              }}
              dir="ltr"
              className="text-start font-mono text-base font-medium pe-9"
              placeholder="1042"
              inputMode="numeric"
            />
            {trimmedParcel ? (
              <button
                type="button"
                onClick={() => {
                  setParcelNumber('');
                  setParcelFromMap(false);
                }}
                className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full"
                aria-label={en ? 'Clear parcel number' : 'مسح رقم العقار'}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        )}

        {parcelFromMap ? (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
            {en ? 'Read from the cadastre' : 'مأخوذ من المسح العقاري'}
          </p>
        ) : null}

        {/*
          The parcel belongs to a different sector from the one being
          looked in. Said, never settled: the code's sector half comes
          from the parcel (D13), so this reports which one the code will
          actually carry and leaves the officer to decide which of the
          two is wrong.
        */}
        {zoneMismatch ? (
          <Alert variant="warning" className="mt-2">
            {en
              ? `Parcel ${trimmedParcel} is in sector ${parcelZone!.code} — ${parcelZone!.name}, not the one selected above. The code will carry ${parcelZone!.code}.`
              : `العقار ${trimmedParcel} يقع في القطاع ${parcelZone!.code} — ${parcelZone!.name}، لا القطاع المختار أعلاه. سيحمل الرمز ${parcelZone!.code}.`}
          </Alert>
        ) : null}

        {cadastreHint ? (
          <Alert variant="warning" className="mt-2">
            {cadastreHint}
          </Alert>
        ) : null}

        <div className="mt-3 border-s-2 border-border ps-3 py-1">
          <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Hash className="size-3.5" />
              {en ? 'Derived Census Code:' : 'رمز المبنى المشتق:'}
            </span>
            <span className="font-mono text-lg sm:text-xl font-bold tracking-tight text-foreground" dir="ltr">
              {displayCode ?? '—'}
            </span>
            {resolving && !editing ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {en ? 'Resolving…' : 'جاري التحقق…'}
              </span>
            ) : editing ? (
              <Badge variant="soft-success" className="text-xs px-2 py-0.5">
                {en ? 'Allocated' : 'معتمد'}
              </Badge>
            ) : (
              <Badge variant="soft-warning" className="text-xs px-2 py-0.5">
                {en ? 'Provisional' : 'مؤقت'}
              </Badge>
            )}
          </div>
          {/* Retired by a correction — still what old forms and receipts quote. */}
          {editing && previousCodes.length > 0 ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {en ? 'Previously: ' : 'رموزه السابقة: '}
              {previousCodes.map((row, index) => (
                <span key={row.code}>
                  {index > 0 ? '، ' : null}
                  <bdi dir="ltr" className="font-mono">
                    {row.code}
                  </bdi>
                </span>
              ))}
              {en ? ' — still found by search.' : ' — ما زالت تدلّ عليه في البحث.'}
            </p>
          ) : null}
        </div>
      </StepField>
    </>
  );
}
