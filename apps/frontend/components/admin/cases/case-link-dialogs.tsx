'use client';

import { Grid3x3 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LinkCaseCitizenDialog, caseLinkUnit } from '@/components/admin/link-case-citizen-dialog';
import type { CaseLinking } from './use-case-linking';

/** «ربط بمواطن» on the case `useCaseLinking` has open, if any. */
export function CaseLinkDialog({
  linkage,
  tenant,
  token,
  locale,
}: {
  linkage: CaseLinking;
  tenant: string;
  token: string;
  locale: string;
}) {
  const { linking, linkSubmitting, linkError, linkSuggested, openLink, linkCitizen, setPendingUnlink } =
    linkage;
  return (
    <LinkCaseCitizenDialog
      open={linking !== null}
      onOpenChange={(open) => {
        if (!open) openLink(null);
      }}
      tenant={tenant}
      token={token}
      currentCitizenName={linking?.resolvedCitizenName}
      submitting={linkSubmitting}
      error={linkError}
      onSubmit={(submission) => void linkCitizen(submission)}
      unit={caseLinkUnit(linking, locale)}
      onUnlink={() => {
        if (!linking) return;
        setPendingUnlink(linking);
        openLink(null);
      }}
      suggested={linkSuggested}
      locale={locale}
    />
  );
}

/**
 * «إلغاء الربط» clears the case's citizen and nothing else. «ربط» may have
 * recorded people on the unit — on it, and on the bill — and unlinking
 * does not take them off, so the confirmation names who is there and
 * opens the unit, where a wrong record is ended (`endOccupancy`).
 */
export function CaseUnlinkDialog({
  linkage,
  locale,
  onOpenUnit,
}: {
  linkage: CaseLinking;
  locale: string;
  /** Opens the unit matrix on the case's flat. */
  onOpenUnit: (target: { buildingId: string; unitId: string | null }) => void;
}) {
  const { pendingUnlink, setPendingUnlink, unlinkCitizen } = linkage;
  const labels = getLabels(locale);
  const pendingUnlinkUnit = caseLinkUnit(pendingUnlink, locale);
  /** Who the unlink confirmation names on the unit, with their capacity. */
  const unlinkOccupants = (pendingUnlink?.unitOccupants ?? [])
    .map((person) => `${person.name} (${labels.occupancyType[person.role as never] ?? person.role})`)
    .join(locale === 'en' ? ', ' : '، ');

  return (
    <ConfirmDialog
      open={pendingUnlink !== null}
      onOpenChange={(open) => {
        if (!open) setPendingUnlink(null);
      }}
      title={locale === 'en' ? 'Unlink this case?' : 'إلغاء ربط الحالة؟'}
      description={
        pendingUnlink
          ? [
              locale === 'en'
                ? `The case will no longer name ${pendingUnlink.resolvedCitizenName ?? 'a citizen'}.`
                : `لن تبقى الحالة باسم ${pendingUnlink.resolvedCitizenName ?? 'مواطن'}.`,
              pendingUnlink.status === 'RESOLVED'
                ? locale === 'en'
                  ? 'It stays marked resolved — reopen it from the list if the visit still needs making.'
                  : 'تبقى محلولة — أعد فتحها من القائمة إن كانت الزيارة ما زالت لازمة.'
                : null,
            ]
              .filter(Boolean)
              .join(' ')
          : undefined
      }
      confirmLabel={locale === 'en' ? 'Unlink' : 'إلغاء الربط'}
      cancelLabel={locale === 'en' ? 'Keep the link' : 'إبقاء الربط'}
      busyLabel={locale === 'en' ? 'Working…' : 'جارٍ التنفيذ…'}
      onConfirm={async () => {
        if (pendingUnlink) await unlinkCitizen(pendingUnlink);
      }}
    >
      {pendingUnlinkUnit && pendingUnlink ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <p>
            {(pendingUnlink.unitOccupants ?? []).length > 0
              ? locale === 'en'
                ? `Unlinking does not take anyone off unit ${pendingUnlinkUnit.label}. Recorded on it now: ${unlinkOccupants}. They stay on the unit and on their bills.`
                : `إلغاء الربط لا يُخرج أحداً من الوحدة ${pendingUnlinkUnit.label}. مسجَّل عليها الآن: ${unlinkOccupants}. يبقون على الوحدة وفي فواتيرهم.`
              : locale === 'en'
                ? `Unlinking does not change who is recorded on unit ${pendingUnlinkUnit.label}.`
                : `إلغاء الربط لا يغيّر من هو مسجَّل على الوحدة ${pendingUnlinkUnit.label}.`}
          </p>
          <p className="text-muted-foreground">
            {locale === 'en'
              ? 'If someone was recorded on it by mistake, end their record from the unit.'
              : 'إن سُجِّل أحدٌ عليها بالخطأ، أنهِ سجلّه من الوحدة نفسها.'}
          </p>
          {pendingUnlink.buildingId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const item = pendingUnlink;
                setPendingUnlink(null);
                onOpenUnit({ buildingId: item.buildingId!, unitId: item.unitId });
              }}
            >
              <Grid3x3 className="size-4" aria-hidden />
              {locale === 'en' ? 'Open the unit' : 'فتح الوحدة'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
