'use client';

import { useEffect, useMemo, useState } from 'react';
import { History, Loader2 } from 'lucide-react';

import { getAuditLog, getRecordHistory, type AuditEntry } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { AuditEntryItem } from '@/components/admin/audit-entry';
import { CollapsibleSection } from '@/components/ui/collapsible-section';

/**
 * Who did what to this one record.
 *
 * The register already wrote all of this down — `audit_log_entries` carries an
 * actor, an action and an `(entityType, entityId)` pair, indexed on the pair —
 * and until now the only way to read it was «سجل النشاطات», which lists the
 * whole municipality's activity and cannot be narrowed to the building you are
 * standing in. The question an officer actually asks is the specific one: who
 * created this building, who linked this citizen to that unit, who ended the
 * tenancy. That question had no screen.
 *
 * Deliberately read-only and deliberately additive: it reads a trail that was
 * always being recorded, and shows it beside the record it describes.
 *
 * ── On the role gate ───────────────────────────────────────────────────────
 * `GET /audit` is `@Roles('SUPER_ADMIN', 'AUDITOR')` and this does not widen
 * that: those two read the record's whole trail. Everyone else who can open a
 * citizen's file or a building reads its «سجل التعديلات» instead —
 * `GET /citizens/:id/history`, `GET /buildings/:id/history` — the changes
 * only, never who viewed the record or how it is being reviewed. For any other
 * record type a role without the full trail renders nothing, rather than an
 * empty panel or a 403 in the console on every page.
 */
export function ActivityTrail({
  tenant,
  locale,
  base,
  entityType,
  entityId,
  className,
  defaultOpen = false,
}: {
  tenant: string;
  locale: string;
  /** `/{tenant}/{locale}/{adminPath}` — where an expired session is sent. */
  base: string;
  /** `Building`, `User`, `Registration`, `Zone` — see `AUDIT_ENTITY`. */
  entityType: string;
  entityId: string | null | undefined;
  className?: string;
  defaultOpen?: boolean;
}) {
  const en = locale === 'en';
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') return;
    setToken(session.accessToken);
    setRole(session.user.role ?? null);
  }, [tenant]);

  /*
    Two readers, two trails. SUPER_ADMIN and AUDITOR keep the whole trail of
    the record — views, exports and reviews included. Everyone else who can
    open a citizen's file or a building reads its «سجل التعديلات»: the changes
    only, which the server narrows and strips (`AuditService.history`). Other
    record types keep the old rule: the full trail or nothing.
  */
  const fullTrail = role === 'SUPER_ADMIN' || role === 'AUDITOR';
  const historyKind =
    entityType === 'User' ? 'citizen' : entityType === 'Building' ? 'building' : null;
  const mayRead = fullTrail || (Boolean(role) && historyKind !== null);

  const { data, loading, error } = useStaffQuery<{ items: AuditEntry[]; total: number }>({
    queryKey: ['staff', tenant, 'activity-trail', fullTrail ? 'full' : 'history', entityType, entityId ?? 'none'],
    // `token: null` is how `useStaffQuery` is told not to run — so a role that
    // may not read this never fires the request at all.
    token: mayRead && entityId ? token : null,
    tenant,
    base,
    queryFn: (tok, signal) =>
      fullTrail || !historyKind
        ? getAuditLog(tenant, tok, { entityType, entityId: entityId ?? undefined, limit: 50 }, signal)
        : getRecordHistory(tenant, tok, { kind: historyKind, id: entityId ?? '' }, { limit: 50 }, signal),
    errorMessage: en ? 'Could not load this record’s history.' : 'تعذّر تحميل سجل هذا القيد.',
  });

  const entries = useMemo(() => data?.items ?? [], [data]);

  if (!mayRead || !entityId) return null;

  return (
    <CollapsibleSection
      id="activity-trail"
      title={
        fullTrail
          ? en
            ? 'Staff activity'
            : 'سجل الموظفين على هذا القيد'
          : en
            ? 'Change history'
            : 'سجل التعديلات'
      }
      icon={History}
      defaultOpen={defaultOpen}
      className={className}
      summary={
        data ? (
          <span className="text-muted-foreground">
            {data.total} {en ? 'step(s)' : 'خطوة'}
          </span>
        ) : null
      }
    >
      <div className="px-5 pb-5">
        {loading ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {en ? 'Loading history…' : 'جارٍ تحميل السجل…'}
          </p>
        ) : error ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : entries.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {en
              ? 'Nothing recorded against this record yet.'
              : 'لم يُسجَّل أي إجراء على هذا القيد بعد.'}
          </p>
        ) : (
          /*
            The same entry the whole-portal trail draws, compact: the record is
            the one on screen, so only who, when and what changed are said. The
            server names the person — the old list printed an email or «النظام»,
            and most census writes carried no email at all.
          */
          <ol className="divide-y">
            {entries.map((entry) => (
              <AuditEntryItem key={entry.id} entry={entry} locale={locale} base={base} compact />
            ))}
          </ol>
        )}
      </div>
    </CollapsibleSection>
  );
}
