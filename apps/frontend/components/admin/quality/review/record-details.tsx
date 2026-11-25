'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { getLabels } from '@mechanization/shared-schemas';
import { flagFieldLabel } from '@/lib/field-flags';
import { formatDateTime, formatRelative } from '@/lib/dates';
import type { ReviewQueueItem } from '@/lib/quality-api';
import { Badge } from '@/components/ui/badge';
import { FactCell, FactRow } from '@/components/ui/facts';

const STATE_BADGE: Record<ReviewQueueItem['state'], 'soft-warning' | 'soft-info' | 'soft-success'> = {
  NEW: 'soft-info',
  CORRECTED: 'soft-warning',
  CHANGED: 'soft-warning',
  RETURNED: 'soft-warning',
  APPROVED: 'soft-success',
};

/**
 * What a reviewer decides on: who filed the record and when, what property it
 * claims, what was left «غير مؤكَّد», and the officer's note. Bands of the card.
 */
export function RecordDetails({
  item,
  base,
  locale,
  labels,
}: {
  item: ReviewQueueItem;
  base: string;
  locale: string;
  labels: ReturnType<typeof getLabels>;
}): React.JSX.Element {
  const t = useTranslations('recordReview');

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Link
          href={`${base}/citizens/${encodeURIComponent(item.citizen.id)}`}
          className="text-base font-semibold text-primary underline-offset-4 hover:underline"
        >
          {item.citizen.name}
        </Link>
        {item.citizen.referenceNumber ? (
          <span dir="ltr" className="font-mono text-xs text-muted-foreground">
            {item.citizen.referenceNumber}
          </span>
        ) : null}
        <Badge variant={STATE_BADGE[item.state]}>{t(`state.${item.state}`)}</Badge>
        <span className="ms-auto text-xs text-muted-foreground" title={formatDateTime(item.submittedAt)}>
          {formatRelative(item.submittedAt, locale)}
        </span>
      </div>

      {/*
        The record itself, on the card's column rhythm.

        This was a run-on line — «سجَّله فلان  والدته فلانة  ٤ أفراد
        مقيم» — readable once and unscannable down a queue of
        twenty. The fields a decision actually turns on (who filed
        it, when it last moved, how many doors it claims) are
        stated rather than left for whoever thinks to open the file.
      */}
      <FactRow>
        <FactCell label={t('card.filedBy')} value={item.officer?.name ?? t('card.unknown')} />
        <FactCell label={t('card.filedOn')} value={formatDateTime(item.submittedAt)} />
        {item.updatedAt !== item.submittedAt ? (
          <FactCell label={t('card.lastEdited')} value={formatDateTime(item.updatedAt)} />
        ) : null}
        <FactCell
          label={t('card.recordRef')}
          className="font-mono"
          value={item.referenceNumber}
        />
        {item.citizen.motherName ? (
          <FactCell label={t('card.mother')} value={item.citizen.motherName} />
        ) : null}
        {item.citizen.householdMembers != null ? (
          <FactCell
            label={t('card.household')}
            value={t('card.householdCount', { count: item.citizen.householdMembers })}
          />
        ) : null}
        <FactCell
          label={t('card.residence')}
          value={labels.citizenResidence[item.citizen.residence as never] ?? item.citizen.residence}
        />
        <FactCell
          label={t('card.properties')}
          value={item.properties.length === 0 ? t('card.noProperty') : `${item.properties.length}`}
        />
      </FactRow>

      {/*
        Each property spelled out rather than squeezed into a pill.
        A «شقة · مالك · عقار 498 · X-498-A · 3 وحدة» chip hides which
        dot is which the moment one of the parts is missing.
      */}
      {item.properties.map((card, index) => (
        <div key={`${item.registrationId}-${index}`} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {item.properties.length > 1 ? t('card.propertyNumbered', { number: index + 1 }) : t('card.property')}
          </p>
          <FactRow>
            <FactCell
              label={t('card.type')}
              value={labels.propertyType[card.propertyType as never] ?? card.propertyType}
            />
            {card.occupancyType ? (
              <FactCell
                label={t('card.occupancy')}
                value={labels.occupancyType[card.occupancyType as never] ?? card.occupancyType}
              />
            ) : null}
            {card.propertyNumber ? (
              <FactCell label={t('card.parcel')} value={card.propertyNumber} />
            ) : null}
            {card.buildingCode || card.buildingName ? (
              <FactCell
                label={t('card.building')}
                value={[card.buildingCode, card.buildingName].filter(Boolean).join(' — ')}
              />
            ) : null}
            {card.unitCount > 0 ? (
              <FactCell
                label={t('card.units')}
                value={t('card.unitCount', { count: card.unitCount })}
              />
            ) : null}
            {card.unitArea != null ? (
              <FactCell
                label={t('card.area')}
                value={t('card.areaValue', { area: String(card.unitArea) })}
              />
            ) : null}
          </FactRow>
        </div>
      ))}

      {item.flags.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-warning">
            {t('card.unconfirmed')}
          </p>
          <FactRow>
            {item.flags.map((flag) => (
              <FactCell
                key={flag.path}
                label={
                  <span className="text-warning">{flagFieldLabel(flag.path, locale)}</span>
                }
                className="max-w-sm text-muted-foreground"
                value={flag.reason}
              />
            ))}
          </FactRow>
        </div>
      ) : null}

      {/* Already its own band — no inner box needed on top of it. */}
      {item.notes ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('card.note')}
          </p>
          <p className="text-xs leading-relaxed">{item.notes}</p>
        </div>
      ) : null}
    </>
  );
}
