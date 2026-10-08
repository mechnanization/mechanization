'use client';

import { useTranslations } from 'next-intl';
import { getLabels, type CitizenResidence } from '@mechanization/shared-schemas';
import { Badge } from '@/components/ui/badge';

/**
 * نوع الملف beside a name, when it is not a household: «غير مقيم في البلدة»,
 * «تركة (ورثة المرحوم)» or «جهة أو وقف» (0076). Nothing for a household — the
 * ordinary case says nothing.
 *
 * `short` is for a tight row (an owner-link candidate): «غير مقيم», «تركة»,
 * «جهة أو وقف».
 */
export function RecordKindBadge({
  residence,
  locale,
  short = false,
}: {
  residence: CitizenResidence | string | null | undefined;
  locale: string;
  short?: boolean;
}) {
  const t = useTranslations('citizenKind');
  if (!residence || residence === 'RESIDENT') return null;
  const labels = getLabels(locale);
  const label = short
    ? residence === 'ESTATE'
      ? t('badgeEstate')
      : residence === 'INSTITUTION'
        ? t('badgeInstitution')
        : t('badgeNonResident')
    : ((labels.citizenResidence as Record<string, string>)[residence] ?? residence);
  return <Badge variant="soft-info">{label}</Badge>;
}
