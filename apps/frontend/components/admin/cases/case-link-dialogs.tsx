'use client';

import { Grid3x3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('cases.unlink');
  const tCommon = useTranslations('common');
  const pendingUnlinkUnit = caseLinkUnit(pendingUnlink, locale);
  /** Who the unlink confirmation names on the unit, with their capacity. */
  const unlinkOccupants = (pendingUnlink?.unitOccupants ?? [])
    .map((person) => `${person.name} (${labels.occupancyType[person.role as never] ?? person.role})`)
    .join(tCommon('listSeparator'));

  return (
    <ConfirmDialog
      open={pendingUnlink !== null}
      onOpenChange={(open) => {
        if (!open) setPendingUnlink(null);
      }}
      title={t('title')}
      description={
        pendingUnlink
          ? [
              t('named', { name: pendingUnlink.resolvedCitizenName ?? t('aCitizen') }),
              pendingUnlink.status === 'RESOLVED' ? t('stillResolved') : null,
            ]
              .filter(Boolean)
              .join(' ')
          : undefined
      }
      confirmLabel={t('confirm')}
      cancelLabel={t('keep')}
      busyLabel={t('working')}
      onConfirm={async () => {
        if (pendingUnlink) await unlinkCitizen(pendingUnlink);
      }}
    >
      {pendingUnlinkUnit && pendingUnlink ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <p>
            {(pendingUnlink.unitOccupants ?? []).length > 0
              ? t('withOccupants', { unit: pendingUnlinkUnit.label, who: unlinkOccupants })
              : t('withoutOccupants', { unit: pendingUnlinkUnit.label })}
          </p>
          <p className="text-muted-foreground">{t('mistake')}</p>
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
              {t('openUnit')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
