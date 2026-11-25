'use client';

import { useState } from 'react';
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
  const en = locale === 'en';
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
    errorMessage: en ? 'Could not load the two records.' : 'تعذّر تحميل السجلّين.',
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
        <LoadingState label={en ? 'Loading both records…' : 'جارٍ تحميل السجلّين…'} />
      </CompareShell>
    );
  }

  const people = query.data;
  const rows = citizenRows(people[0], people[1], locale);

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
      <DifferenceSummary rows={rows} locale={locale} />

      {!canEdit ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {en
              ? 'Your role reviews records but does not change them. Open either file to have an administrative officer correct it.'
              : 'دورك يراجع السجلات ولا يعدّلها. افتح الملف ليصحّحه موظف إداري.'}
          </span>
        </p>
      ) : null}

      <CompareTable
        locale={locale}
        headers={[
          <RecordHeading
            key="a"
            title={people[0].fullName}
            secondary={people[0].referenceNumber}
            href={`${base}/citizens/${encodeURIComponent(people[0].id)}`}
            openLabel={en ? 'Open the file' : 'فتح الملف'}
          />,
          <RecordHeading
            key="b"
            title={people[1].fullName}
            secondary={people[1].referenceNumber}
            href={`${base}/citizens/${encodeURIComponent(people[1].id)}`}
            openLabel={en ? 'Open the file' : 'فتح الملف'}
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
            {en
              ? 'If these are one person, merge them: the file registered first stays, everything the other holds moves onto it, and the other is deactivated. It can be undone while neither file changes.'
              : 'إن كانا شخصاً واحداً فادمجهما: يبقى الملف المسجَّل أولاً، وينتقل إليه كل ما على الآخر، ويُعطَّل الآخر. يمكن التراجع عن الدمج ما دام الملفان لم يتغيّرا.'}
          </p>
          <Button size="sm" className="shrink-0 gap-1.5" onClick={() => setMerging(true)}>
            <GitMerge className="size-4" aria-hidden />
            {en ? 'Merge the two files' : 'دمج الملفين'}
          </Button>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {en
            ? 'If this is one person, an administrator can merge the two files from this screen. Until then, correct whichever record is wrong.'
            : 'إن كانا شخصاً واحداً فيمكن لمدير النظام دمج الملفين من هذه الشاشة. وإلى ذلك الحين صحِّح السجل الخاطئ.'}
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
            toast.success(en ? 'The two files were merged.' : 'دُمج الملفان.');
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
        title={en ? 'Save this change?' : 'هل أنت متأكد من إجراء هذا التغيير؟'}
        description={
          pending ? (
            <span className="block space-y-2">
              <span className="block">
                {en
                  ? 'This writes to the citizen’s file and is recorded in the audit trail.'
                  : 'يُكتب هذا في ملف المواطن ويُسجَّل في سجل التدقيق.'}
              </span>
              <span className="block rounded-md border bg-muted/40 p-2.5 text-sm">
                <span className="block text-xs text-muted-foreground">{pending.label}</span>
                <ChangeValue
                  before={pending.before}
                  after={pending.after}
                  becameLabel={en ? 'becomes' : 'يصبح'}
                />
              </span>
            </span>
          ) : null
        }
        confirmLabel={en ? 'Save' : 'موافق — احفظ'}
        cancelLabel={en ? 'Cancel' : 'إلغاء'}
        busyLabel={en ? 'Working…' : 'جارٍ التنفيذ…'}
        onConfirm={save}
      />
    </CompareShell>
  );
}
