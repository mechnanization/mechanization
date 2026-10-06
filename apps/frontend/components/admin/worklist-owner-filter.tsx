'use client';

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { WORKLIST_UNASSIGNED } from '@mechanization/shared-schemas';
import { param, type UrlParam } from '@/lib/url-state';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';

/**
 * Whose work a collection worklist shows, for the roles that see everyone's —
 * «يتطلب مراجعة», «وحدات غير ممسوحة», «بانتظار إعادة الكشف».
 *
 * Everyone's, or the work whose officer is gone (`WORKLIST_UNASSIGNED`: never
 * recorded, archived in «الأرشيف», or deleted) — so a leaver's open doors and
 * records do not drop out of every list but the unfiltered one. One officer's
 * is reached by pressing their name on a row; it shows here as a chip to clear.
 * An officer's own list is narrowed on the server whatever is sent, so this
 * control is shown only to those who see everyone's.
 */

const ID = param.id();

/** `owner` in the URL: empty (everyone's), `UNASSIGNED`, or a staff id. */
export const WORKLIST_OWNER_PARAM: UrlParam<string> = {
  parse: (raw) => (raw === WORKLIST_UNASSIGNED ? WORKLIST_UNASSIGNED : ID.parse(raw)),
  serialize: (value) => (value === WORKLIST_UNASSIGNED ? WORKLIST_UNASSIGNED : ID.serialize(value)),
};

export function WorklistOwnerFilter({
  value,
  onChange,
  ownerName,
}: {
  value: string;
  onChange: (owner: string) => void;
  /** The name of the officer `value` names, when it names one. */
  ownerName: string | null;
}) {
  const t = useTranslations('worklist');
  const officer = value !== '' && value !== WORKLIST_UNASSIGNED;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        aria-label={t('owner.label')}
        fullWidth={false}
        size="sm"
        value={officer ? undefined : value === '' ? 'ALL' : WORKLIST_UNASSIGNED}
        onChange={(next) => onChange(next === 'ALL' ? '' : next)}
        options={[
          { value: 'ALL', label: t('owner.all') },
          { value: WORKLIST_UNASSIGNED, label: t('owner.unassigned') },
        ]}
      />
      {officer ? (
        <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 ps-2.5 text-xs">
          {t('owner.officer', { name: ownerName ?? '—' })}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('owner.clear')}
            onClick={() => onChange('')}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </span>
      ) : null}
    </div>
  );
}
