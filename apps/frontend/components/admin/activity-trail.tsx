'use client';

import { useEffect, useMemo, useState } from 'react';
import { History, Loader2 } from 'lucide-react';

import { getAuditLog, type AuditEntry } from '@/lib/api-client';
import { auditActionLabel } from '@/lib/audit-labels';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { cn } from '@/lib/utils';

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
 * that. A `FIELD_INSPECTOR` on the same page renders nothing at all rather
 * than an empty panel or a permission error — an inspector has no use for a
 * box that only ever tells them they may not look in it, and a 403 in the
 * console on every building page would train everyone to ignore console
 * errors. If the trail should be visible to more roles, that is a decision
 * about the endpoint, not about this component.
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

  const mayRead = role === 'SUPER_ADMIN' || role === 'AUDITOR';

  const { data, loading, error } = useStaffQuery<{ items: AuditEntry[]; total: number }>({
    queryKey: ['staff', tenant, 'activity-trail', entityType, entityId ?? 'none'],
    // `token: null` is how `useStaffQuery` is told not to run — so a role that
    // may not read this never fires the request at all.
    token: mayRead && entityId ? token : null,
    tenant,
    base,
    queryFn: (tok, signal) =>
      getAuditLog(tenant, tok, { entityType, entityId: entityId ?? undefined, limit: 50 }, signal),
    errorMessage: en ? 'Could not load this record’s history.' : 'تعذّر تحميل سجل هذا القيد.',
  });

  const entries = useMemo(() => data?.items ?? [], [data]);

  if (!mayRead || !entityId) return null;

  return (
    <CollapsibleSection
      id="activity-trail"
      title={en ? 'Staff activity' : 'سجل الموظفين على هذا القيد'}
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
          <ol className="space-y-0">
            {entries.map((entry, index) => (
              <li
                key={entry.id}
                className={cn(
                  'flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2.5 text-sm',
                  index > 0 && 'border-t',
                )}
              >
                <span className="font-medium text-foreground">
                  {auditActionLabel(entry.action, locale)}
                </span>
                {/* The actor. `actorEmail` is what the log stores — there is no
                    name column on the entry, and resolving one per row would be
                    a lookup per line for a panel that is usually closed. */}
                <span className="text-muted-foreground" dir="ltr">
                  {entry.actorEmail ?? (en ? 'system' : 'النظام')}
                </span>
                <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString(en ? 'en-GB' : 'ar-LB', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </CollapsibleSection>
  );
}
