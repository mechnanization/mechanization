import Link from 'next/link';
import type { getLabels } from '@mechanization/shared-schemas';
import { flagFieldLabel } from '@/lib/field-flags';
import { formatDateTime, formatRelative } from '@/lib/dates';
import type { ReviewQueueItem } from '@/lib/quality-api';
import { Badge } from '@/components/ui/badge';
import { FactCell, FactRow } from '@/components/ui/facts';

const STATE_BADGE: Record<ReviewQueueItem['state'], { variant: 'soft-warning' | 'soft-info' | 'soft-success' | 'soft-muted'; ar: string; en: string }> = {
  NEW: { variant: 'soft-info', ar: 'جديد', en: 'New' },
  CORRECTED: { variant: 'soft-warning', ar: 'صُحِّح — بانتظار المراجعة', en: 'Corrected — needs review' },
  CHANGED: { variant: 'soft-warning', ar: 'عُدِّل بعد الاعتماد', en: 'Edited since approval' },
  RETURNED: { variant: 'soft-warning', ar: 'عند الموظف للتصحيح', en: 'With the officer' },
  APPROVED: { variant: 'soft-success', ar: 'معتمد', en: 'Approved' },
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
  const en = locale === 'en';
  const badge = STATE_BADGE[item.state];

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
        <Badge variant={badge.variant}>{en ? badge.en : badge.ar}</Badge>
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
        <FactCell
          label={en ? 'Filed by' : 'سجَّله'}
          value={item.officer?.name ?? (en ? 'unknown' : 'غير معروف')}
        />
        <FactCell label={en ? 'Filed on' : 'تاريخ التقديم'} value={formatDateTime(item.submittedAt)} />
        {item.updatedAt !== item.submittedAt ? (
          <FactCell label={en ? 'Last edited' : 'آخر تعديل'} value={formatDateTime(item.updatedAt)} />
        ) : null}
        <FactCell
          label={en ? 'Record ref.' : 'مرجع السجل'}
          className="font-mono"
          value={item.referenceNumber}
        />
        {item.citizen.motherName ? (
          <FactCell label={en ? 'Mother' : 'اسم الأم'} value={item.citizen.motherName} />
        ) : null}
        {item.citizen.householdMembers != null ? (
          <FactCell
            label={en ? 'Household' : 'أفراد الأسرة'}
            value={
              en
                ? `${item.citizen.householdMembers}`
                : `${item.citizen.householdMembers} أفراد`
            }
          />
        ) : null}
        <FactCell
          label={en ? 'Residence' : 'مكان الإقامة'}
          value={labels.citizenResidence[item.citizen.residence as never] ?? item.citizen.residence}
        />
        <FactCell
          label={en ? 'Properties' : 'العقارات'}
          value={
            item.properties.length === 0
              ? en
                ? 'none on this record'
                : 'لا عقار على هذا السجل'
              : en
                ? `${item.properties.length}`
                : `${item.properties.length}`
          }
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
            {item.properties.length > 1
              ? `${en ? 'Property' : 'العقار'} ${index + 1}`
              : en
                ? 'Property'
                : 'العقار'}
          </p>
          <FactRow>
            <FactCell
              label={en ? 'Type' : 'النوع'}
              value={labels.propertyType[card.propertyType as never] ?? card.propertyType}
            />
            {card.occupancyType ? (
              <FactCell
                label={en ? 'Occupancy' : 'صفة الإشغال'}
                value={labels.occupancyType[card.occupancyType as never] ?? card.occupancyType}
              />
            ) : null}
            {card.propertyNumber ? (
              <FactCell label={en ? 'Parcel' : 'رقم العقار'} value={card.propertyNumber} />
            ) : null}
            {card.buildingCode || card.buildingName ? (
              <FactCell
                label={en ? 'Building' : 'المبنى'}
                value={[card.buildingCode, card.buildingName].filter(Boolean).join(' — ')}
              />
            ) : null}
            {card.unitCount > 0 ? (
              <FactCell
                label={en ? 'Units' : 'عدد الوحدات'}
                value={en ? `${card.unitCount}` : `${card.unitCount} وحدة`}
              />
            ) : null}
            {card.unitArea != null ? (
              <FactCell
                label={en ? 'Area' : 'المساحة'}
                value={`${card.unitArea} ${en ? 'm²' : 'م²'}`}
              />
            ) : null}
          </FactRow>
        </div>
      ))}

      {item.flags.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-warning">
            {en ? 'Fields left unconfirmed' : 'حقول غير مؤكَّدة'}
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
            {en ? 'Officer’s note' : 'ملاحظة الموظف'}
          </p>
          <p className="text-xs leading-relaxed">{item.notes}</p>
        </div>
      ) : null}
    </>
  );
}
