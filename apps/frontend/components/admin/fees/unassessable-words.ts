'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { getLabels, unitLevelsLabel } from '@mechanization/shared-schemas';
import type { FeeUnassessable } from '@mechanization/shared-schemas';

/** A citizen the notice cannot assess, worded for the screen. */
export interface UnassessableWords {
  /** The unit that stopped it, by code and parcel; null when the server named none. */
  where: string | null;
  /** Its type, area and levels, as the register holds them; null when there are none to say. */
  facts: string | null;
  /** Why it stopped the assessment. */
  why: string;
  /** What to do so the next notice can assess them; null when the server sent no code. */
  fix: string | null;
}

/**
 * Why a citizen cannot be assessed, in words a clerk can act on (2026-10-27):
 * the unit, its type, area and levels, what is missing, and what to do — by
 * the reason's code (`FEE_UNASSESSABLE_REASON`), in the screen's language.
 * The server's own sentence named only the unit and said no more than «لا تقع
 * في أي فئة»; it is still the words for an answer that carries no code.
 * Read by the preview's list and the panel an issue leaves on screen.
 */
export function useUnassessableWords(locale: string): (entry: FeeUnassessable) => UnassessableWords {
  const t = useTranslations('fees.unassessable');
  const tMatrix = useTranslations('fees.matrix');

  // Stable across renders, so a table fed by it keeps its page and search.
  return useCallback((entry: FeeUnassessable): UnassessableWords => {
    const labels = getLabels(locale);
    const unit = entry.unit;
    if (!entry.code || !unit) return { where: null, facts: null, why: entry.reason, fix: null };

    const parcel = unit.propertyNumber ?? '—';
    const type = unit.unitType ? (labels.unitType[unit.unitType as keyof typeof labels.unitType] ?? unit.unitType) : null;
    const levels = unitLevelsLabel(unit.levels, locale) ?? tMatrix('oneLevel');
    const area = unit.unitArea === null ? null : unit.unitArea.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const multi = unit.levels > 1 ? 'yes' : 'no';

    const where =
      entry.code === 'UNSURVEYED'
        ? t('building', { parcel })
        : unit.unitCode
          ? t('unit', { unitCode: unit.unitCode, parcel })
          : t('parcelOnly', { parcel });
    const facts =
      entry.code === 'UNSURVEYED'
        ? null
        : [type, levels, area === null ? t('noArea') : t('area', { area })].filter(Boolean).join(t('separator'));

    const params = { type: type ?? t('unknownType'), levels, area: area ?? '—', multi, count: String(unit.levels) };
    return { where, facts, why: t(`why.${entry.code}`, params), fix: t(`fix.${entry.code}`, params) };
  }, [t, tMatrix, locale]);
}
