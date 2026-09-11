'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Clock, MapPin, Phone, Trash2, Upload, UploadCloud } from 'lucide-react';
import {
  ApiRequestError,
  getMunicipalitySettings,
  logApiError,
  updateMunicipalitySettings,
} from '@/lib/api-client';
import type { MunicipalitySettings } from '@/lib/api-client';
import type { SettingsCopy } from '@/lib/settings-i18n';
import { Button } from '@/components/ui/button';

import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  AlignedFieldGrid,
  SectionSaveRow,
  SettingsCard,
  FieldGroup,
  SettingsField,
} from './settings-ui';

/**
 * The profile fields, all of which `PATCH /fees/settings` now accepts.
 *
 * Strings throughout, including where the stored value is nullable: `''` is
 * what an emptied input holds, and the server reads it as "clear this". A
 * `null` in state would mean a controlled input turning uncontrolled the
 * moment a clerk deletes the last character of a phone number.
 */
interface Profile {
  contactPhone: string;
  whatsappNumber: string;
  cashOfficeHours: string;
  cashOfficeAddress: string;
  nameAr: string;
  nameEn: string;
  contactEmail: string;
  website: string;
  governorate: string;
  district: string;
  town: string;
  /** تاريخ ورقم قرار المجلس البلدي, if the council has issued one (§7 Q1). */
  councilDecisionRef: string;
  /** A data: URI. See the note on `readLogo` for why it is not a URL. */
  logoDataUri: string;
}

const EMPTY: Profile = {
  contactPhone: '',
  whatsappNumber: '',
  cashOfficeHours: '',
  cashOfficeAddress: '',
  nameAr: '',
  nameEn: '',
  contactEmail: '',
  website: '',
  governorate: '',
  district: '',
  town: '',
  councilDecisionRef: '',
  logoDataUri: '',
};

/** 500 KB. A municipal crest is a few tens of KB; past this it is a photograph. */
const MAX_LOGO_BYTES = 500 * 1024;

function toProfile(settings: MunicipalitySettings): Profile {
  return {
    contactPhone: settings.contactPhone ?? '',
    whatsappNumber: settings.whatsappNumber ?? '',
    cashOfficeHours: settings.cashOfficeHours ?? '',
    cashOfficeAddress: settings.cashOfficeAddress ?? '',
    nameAr: settings.nameAr ?? '',
    nameEn: settings.nameEn ?? '',
    contactEmail: settings.contactEmail ?? '',
    website: settings.website ?? '',
    governorate: settings.governorate ?? '',
    district: settings.district ?? '',
    town: settings.town ?? '',
    councilDecisionRef: settings.councilDecisionRef ?? '',
    logoDataUri: settings.logoDataUri ?? '',
  };
}

/**
 * الملف الشخصي للبلدية — who this municipality is, as the portal states it.
 *
 * All of it now saves to `PATCH /fees/settings`. Identity, region and the crest
 * were kept in the browser until migration 0015 gave them columns; they were
 * the wrong thing to hold locally, since the whole point of a municipality's
 * name and logo is that every clerk and every printed document agrees on them.
 *
 * The section sends only the twelve keys it owns. The endpoint writes only what
 * it is sent, so saving here cannot clear the exchange rate or the numbering
 * prefixes belonging to sections this form never rendered.
 */
export function ProfileSection({
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

  const [saved, setSaved] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getMunicipalitySettings(tenant, token, { includeLogo: true });
        if (cancelled) return;
        const next = toProfile(result);
        setSaved(next);
        setDraft(next);
        setError(null);
      } catch (caught) {
        logApiError(caught);
        if (!cancelled) {
          setError(
            caught instanceof ApiRequestError ? caught.message : copy.common.loadError,
          );
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
    () => saved !== null && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const result = await updateMunicipalitySettings(tenant, token, draft);
      const next = toProfile(result);
      // Re-seeded from the response, not from the draft: the server trims and
      // normalises, so echoing the draft back would leave the form looking
      // clean while holding a value the database does not have.
      setSaved(next);
      setDraft(next);
      toast.success(copy.common.saved);
      setError(null);
    } catch (caught) {
      logApiError(caught);
      const message =
        caught instanceof ApiRequestError ? caught.message : copy.common.saveError;
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [tenant, token, draft, toast, copy.common]);

  const discard = useCallback(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  /**
   * Reads the chosen file into a data: URI.
   *
   * There is no upload endpoint and no object store configured for this app, so
   * a URL would have nowhere to point. Inlining keeps the preview honest — what
   * is shown is what is stored — at the cost of a size ceiling, which a crest
   * comfortably fits under and a photograph does not, which is the right way
   * round.
   */
  const readLogo = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        toast.error(copy.profile.logoWrongType);
        return;
      }
      if (file.size > MAX_LOGO_BYTES) {
        toast.error(copy.profile.logoTooLarge, { description: copy.profile.logoConstraints });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setDraft({ ...draft, logoDataUri: reader.result });
        }
      };
      reader.readAsDataURL(file);
    },
    [draft, toast, copy.profile],
  );

  if (loading) {
    return <Skeleton className="h-[40rem] rounded-lg" />;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/*
        One card, one save — Solar's shape. The five cards this replaces all
        wrote the same payload through the same button, which meant a save row
        under «دوام المكتب» was also committing the municipality's name four
        cards above it. The grouping survives as labelled sub-blocks, which cost
        a rule and a caption rather than a card, header and shadow each.
      */}
      <SettingsCard
        icon={Building2}
        title={copy.profile.title}
        hint={copy.profile.description}
      >
        <div className="space-y-5">
          <FieldGroup icon={Building2} title={copy.profile.identityHeading}>
            <AlignedFieldGrid>
              <SettingsField
                label={copy.profile.nameAr}
                htmlFor="name-ar"
              >
                <Input
                  id="name-ar"
                  dir="rtl"
                  value={draft.nameAr}
                  onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })}
                />
              </SettingsField>
              <SettingsField
                label={copy.profile.nameEn}
                htmlFor="name-en"
              >
                <Input
                  id="name-en"
                  dir="ltr"
                  className="text-start"
                  value={draft.nameEn}
                  onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })}
                />
              </SettingsField>
            </AlignedFieldGrid>
          </FieldGroup>

          <FieldGroup icon={Phone} title={copy.profile.contactHeading}>
            <AlignedFieldGrid>
              <SettingsField
                label={copy.profile.phone}
                htmlFor="phone"
              >
                <Input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  className="text-start"
                  value={draft.contactPhone}
                  onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })}
                />
              </SettingsField>
              <SettingsField
                label={copy.profile.whatsapp}
                htmlFor="whatsapp"
              >
                <Input
                  id="whatsapp"
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  className="text-start"
                  value={draft.whatsappNumber}
                  onChange={(e) => setDraft({ ...draft, whatsappNumber: e.target.value })}
                />
              </SettingsField>
              <SettingsField label={copy.profile.email} htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  dir="ltr"
                  className="text-start"
                  placeholder="info@municipality.gov.lb"
                  value={draft.contactEmail}
                  onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })}
                />
              </SettingsField>
              <SettingsField label={copy.profile.website} htmlFor="website">
                <Input
                  id="website"
                  type="url"
                  dir="ltr"
                  className="text-start"
                  placeholder="https://"
                  value={draft.website}
                  onChange={(e) => setDraft({ ...draft, website: e.target.value })}
                />
              </SettingsField>
            </AlignedFieldGrid>
          </FieldGroup>

          <FieldGroup icon={MapPin} title={copy.profile.regionHeading}>
            <AlignedFieldGrid columns={3}>
              <SettingsField label={copy.profile.governorate} htmlFor="governorate">
                <Input
                  id="governorate"
                  value={draft.governorate}
                  onChange={(e) => setDraft({ ...draft, governorate: e.target.value })}
                />
              </SettingsField>
              <SettingsField label={copy.profile.district} htmlFor="district">
                <Input
                  id="district"
                  value={draft.district}
                  onChange={(e) => setDraft({ ...draft, district: e.target.value })}
                />
              </SettingsField>
              <SettingsField label={copy.profile.town} htmlFor="town">
                <Input
                  id="town"
                  value={draft.town}
                  onChange={(e) => setDraft({ ...draft, town: e.target.value })}
                />
              </SettingsField>
            </AlignedFieldGrid>

            {/*
              Under the administrative location because that is what it is: the
              authority the municipality's own numbering rests on. Optional, and
              §7 Q1 is why — internal cadastral indexing is already within
              municipal executive competence, so the codes are valid without a
              decree. Where a council has passed one, a notice that cites it
              carries more weight.
            */}
            <AlignedFieldGrid>
              <SettingsField
                label={copy.profile.councilDecisionRef}
                htmlFor="council-decision-ref"
              >
                <Input
                  id="council-decision-ref"
                  placeholder="قرار رقم ١٢ تاريخ ٢٠٢٦/٠٣/١٤"
                  value={draft.councilDecisionRef}
                  onChange={(e) => setDraft({ ...draft, councilDecisionRef: e.target.value })}
                />
                {/* Spelled out under the input rather than passed as `hint`,
                    which `SettingsField` accepts and does not render. */}
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {copy.profile.councilDecisionHint}
                </p>
              </SettingsField>
            </AlignedFieldGrid>
          </FieldGroup>

          <FieldGroup icon={Clock} title={copy.profile.officeHeading}>
            <AlignedFieldGrid>
              <SettingsField label={copy.profile.officeHours} htmlFor="office-hours">
                <Input
                  id="office-hours"
                  placeholder={copy.profile.officeHoursPlaceholder}
                  value={draft.cashOfficeHours}
                  onChange={(e) => setDraft({ ...draft, cashOfficeHours: e.target.value })}
                />
              </SettingsField>
              <SettingsField label={copy.profile.officeAddress} htmlFor="office-address">
                <Input
                  id="office-address"
                  placeholder={copy.profile.officeAddressPlaceholder}
                  value={draft.cashOfficeAddress}
                  onChange={(e) => setDraft({ ...draft, cashOfficeAddress: e.target.value })}
                />
              </SettingsField>
            </AlignedFieldGrid>
          </FieldGroup>

          {/*
            Solar's logo block: a bordered sub-panel with its own caption and
            constraint note, a drop target while empty and a preview row once
            set. The drop target is the part worth copying — an administrator
            with the file already in a folder should not have to go through a
            file dialog to get it here.
          */}
          <div className="space-y-3 rounded-xl border bg-muted/10 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <UploadCloud className="size-4 text-primary" aria-hidden />
                {copy.profile.logoHeading}
              </div>
              <span className="text-xs text-muted-foreground">
                {copy.profile.logoConstraints}
              </span>
            </div>

            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readLogo(file);
                // Cleared so choosing the same file twice still fires a change.
                e.target.value = '';
              }}
            />

            {draft.logoDataUri ? (
              <div className="flex flex-col items-start gap-4 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  {/*
                    A white plate behind the crest regardless of theme: a
                    municipal seal is drawn for paper, and a dark-mode card
                    turns a black-on-transparent PNG into an invisible square.
                  */}
                  <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white p-2">
                    {/*
                      A plain <img>: the source is a data: URI the administrator
                      just chose, so there is nothing for next/image to fetch,
                      resize or cache, and it would need a host allow-listed for
                      a URL that has no host.
                    */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={draft.logoDataUri}
                      alt={copy.profile.logoAlt}
                      className="size-full object-contain"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {draft.nameAr || copy.profile.logoAlt}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {copy.profile.logoHint}
                    </p>
                  </div>
                </div>
                <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                  <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                    <Upload className="size-4" aria-hidden />
                    {copy.profile.logoReplace}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDraft({ ...draft, logoDataUri: '' })}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {copy.profile.logoRemove}
                  </Button>
                </div>
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  // A div carrying a click handler is invisible to the keyboard
                  // without this, and the file dialog would be unreachable
                  // without a mouse.
                  if (e.key === 'Enter' || e.key === ' ') {
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
                  if (file) readLogo(file);
                }}
                className={cn(
                  'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all',
                  dragging
                    ? 'border-primary/60 bg-muted/30'
                    : 'border-muted-foreground/25 bg-muted/10 hover:border-primary/60 hover:bg-muted/30',
                )}
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-110">
                  <UploadCloud className="size-6" aria-hidden />
                </div>
                <p className="text-sm">
                  <span className="font-semibold group-hover:text-primary">
                    {copy.profile.logoUpload}
                  </span>{' '}
                  <span className="text-muted-foreground">{copy.profile.logoDropHint}</span>
                </p>
                <p className="text-xs text-muted-foreground">{copy.profile.logoConstraints}</p>
              </div>
            )}
          </div>
        </div>

        <SectionSaveRow
          copy={copy}
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onDiscard={discard}
        />
      </SettingsCard>
    </div>
  );
}

