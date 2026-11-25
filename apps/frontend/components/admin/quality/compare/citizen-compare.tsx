'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { GitMerge, ShieldAlert } from 'lucide-react';
import { getCitizenProfile } from '@/lib/api-client';
import type { FindingSubject, QualityFinding } from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ChangeValue } from '@/components/ui/facts';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { MergeCitizensDialog } from '../../merge-citizens-dialog';
import { citizenRows, type EditableRow } from './citizen-rows';
import { CompareShell, DifferenceSummary } from './compare-shell';
import { CompareTable, RecordHeading } from './compare-table';
import { EditCell } from './edit-cell';
import { useCitizenCorrection } from './use-citizen-correction';

/** Two files side by side: the three facts a duplicate is decided on correctable in place, and the merge. */
export function CitizenCompare({
  finding,
  pair,
  tenant,
  base,
  locale,
  token,
  canEdit,
  canMerge,
  onBack,
  onChanged,
}: {
  finding: QualityFinding;
  pair: { a: FindingSubject; b: FindingSubject };
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  canEdit: boolean;
  canMerge: boolean;
  onBack: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const t = useTranslations('qualityCompare.citizens');
  const tRows = useTranslations('qualityCompare.rows');
  const tConfirm = useTranslations('qualityCompare.confirm');
  const toast = useToast();
  const router = useRouter();
  const [merging, setMerging] = useState(false);

  const query = useStaffQuery({
    queryKey: ['quality-compare-citizens', tenant, pair.a.id, pair.b.id],
    queryFn: (tok) =>
      Promise.all([
        getCitizenProfile(tenant, tok, pair.a.id),
        getCitizenProfile(tenant, tok, pair.b.id),
      ]),
    tenant,
    base,
    token,
    errorMessage: t('loadFailed'),
    keepPrevious: true,
  });

  const correction = useCitizenCorrection({
    tenant,
    token,
    locale,
    onSaved: () => {
      query.refetch();
      // A corrected name or phone may dissolve the finding itself — the queue
      // behind this screen has to hear about it.
      onChanged();
    },
  });
  const { pending, setPending, save } = correction;

  if (query.error) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <ErrorState description={query.error} offline={query.offline} onRetry={query.refetch} />
      </CompareShell>
    );
  }

  if (query.loading || !query.data) {
    return (
      <CompareShell finding={finding} locale={locale} onBack={onBack}>
        <LoadingState label={t('loading')} />
      </CompareShell>
    );
  }

  const people = query.data;
  const rows = citizenRows(people[0], people[1], locale, tRows);

  /*
    The three anchor rows carry their own control. They are the fields every
    registration is keyed on — الاسم، اسم الأم وشهرتها، الهاتف — which is exactly
    why they are the ones worth correcting from a comparison: a duplicate is
    decided on them, and so is the correction that dissolves it.
  */
  const withEditing = rows.map((entry) => {
    const target: EditableRow | null =
      entry.key === 'name'
        ? 'name'
        : entry.key === 'motherName'
          ? 'motherName'
          : entry.key === 'phone'
            ? 'phone'
            : null;
    if (!target) return entry;
    return {
      ...entry,
      cells: [0, 1].map((side) => (
        <span key={side} className="block">
          {entry.cells[side as 0 | 1]}
          <EditCell
            side={side as 0 | 1}
            target={target}
            person={people[side as 0 | 1]}
            correction={correction}
            canEdit={canEdit}
            locale={locale}
          />
        </span>
      )) as [React.ReactNode, React.ReactNode],
    };
  });

  return (
    <CompareShell finding={finding} locale={locale} onBack={onBack}>
      <DifferenceSummary rows={rows} />

      {!canEdit ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {t('reviewOnly')}
          </span>
        </p>
      ) : null}

      <CompareTable
        headers={[
          <RecordHeading
            key="a"
            title={people[0].fullName}
            secondary={people[0].referenceNumber}
            href={`${base}/citizens/${encodeURIComponent(people[0].id)}`}
            openLabel={t('openFile')}
          />,
          <RecordHeading
            key="b"
            title={people[1].fullName}
            secondary={people[1].referenceNumber}
            href={`${base}/citizens/${encodeURIComponent(people[1].id)}`}
            openLabel={t('openFile')}
          />,
        ]}
        shortHeaders={[people[0].fullName, people[1].fullName]}
        rows={withEditing}
      />

      {/*
        «دمج الملفين» — an administrator's, and only once both records have been
        read side by side, which is what this screen is. Everyone else is told
        who can do it rather than shown a button the server would refuse.
      */}
      {canMerge && token ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('mergeBody')}
          </p>
          <Button size="sm" className="shrink-0 gap-1.5" onClick={() => setMerging(true)}>
            <GitMerge className="size-4" aria-hidden />
            {t('merge')}
          </Button>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('mergeElsewhere')}
        </p>
      )}

      {merging && token ? (
        <MergeCitizensDialog
          open
          onOpenChange={(next) => (next ? undefined : setMerging(false))}
          tenant={tenant}
          token={token}
          locale={locale}
          firstId={people[0].id}
          secondId={people[1].id}
          onMerged={(result) => {
            setMerging(false);
            toast.success(t('merged'));
            onChanged();
            router.push(`${base}/citizens/${encodeURIComponent(result.keepId)}`);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        destructive={false}
        title={tConfirm('title')}
        description={
          pending ? (
            <span className="block space-y-2">
              <span className="block">
                {tConfirm('body')}
              </span>
              <span className="block rounded-md border bg-muted/40 p-2.5 text-sm">
                <span className="block text-xs text-muted-foreground">{pending.label}</span>
                <ChangeValue
                  before={pending.before}
                  after={pending.after}
                  becameLabel={tConfirm('becomes')}
                />
              </span>
            </span>
          ) : null
        }
        confirmLabel={tConfirm('save')}
        cancelLabel={tConfirm('cancel')}
        busyLabel={tConfirm('busy')}
        onConfirm={save}
      />
    </CompareShell>
  );
}
