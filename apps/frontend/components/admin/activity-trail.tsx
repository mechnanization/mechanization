'use client';

import { useEffect, useMemo, useState } from 'react';
import { History, Loader2 } from 'lucide-react';

import { getAuditLog, type AuditEntry } from '@/lib/api-client';
import {
  auditActionLabel,
  auditChanges,
  auditFieldLabel,
  auditValueText,
} from '@/lib/audit-labels';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
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
          /*
            A timeline, because a trail is a sequence and a flat list of rows
            does not say so. The rail and its dots are drawn with a border and
            a ring rather than an SVG, so they follow the text size and flip
            with the writing direction without anything measuring them.
          */
          <ol className="relative space-y-0 border-s ps-5">
            {entries.map((entry) => {
              const changes = auditChanges(entry.before, entry.after);
              const when = new Date(entry.createdAt);
              return (
                /*
                  A rule between entries. The rail down the side says these are
                  one sequence; it does not say where one step stops and the
                  next starts — and now that an entry can carry several change
                  lines under it, two entries run together into one block of
                  small text without a line to part them.
                */
                <li
                  key={entry.id}
                  className="relative border-b border-border/50 py-3 first:pt-0 last:border-0 last:pb-0"
                >
                  <span
                    aria-hidden
                    className="absolute -start-[1.5625rem] top-4 size-2 rounded-full bg-border ring-4 ring-card first:top-1"
                  />

                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium text-foreground">
                      {auditActionLabel(entry.action, locale)}
                    </span>
                    {/*
                      The actor. `actorEmail` is what the log stores — there is
                      no name column on the entry, and resolving one per row
                      would be a lookup per line for a panel usually closed.
                      The role beside it is the thing a reader actually wants
                      from an unfamiliar address: not who, but what they were
                      allowed to do.
                    */}
                    <span className="text-muted-foreground" dir="ltr">
                      {entry.actorEmail ?? (en ? 'system' : 'النظام')}
                    </span>
                    {entry.actorRole ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {entry.actorRole}
                      </span>
                    ) : null}
                    <time
                      dateTime={entry.createdAt}
                      title={when.toLocaleString(en ? 'en-GB' : 'ar-LB')}
                      className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {when.toLocaleString(en ? 'en-GB' : 'ar-LB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </div>

                  {/*
                    What the action did. `before`/`after` have been on every row
                    since the table existed and no screen ever read them, so the
                    trail could say that a record was edited and never what the
                    edit was.

                    An action with no field diff — a login, a document opened —
                    renders nothing here rather than an empty «لا تغييرات», which
                    would be a line saying that a line was not needed.
                  */}
                  {changes.length > 0 ? (
                    <dl className="mt-1.5 space-y-1">
                      {changes.map((change) => (
                        <div
                          key={change.field}
                          className="flex flex-wrap items-baseline gap-x-2 text-xs"
                        >
                          <dt className="text-muted-foreground">
                            {auditFieldLabel(change.field, locale)}:
                          </dt>
                          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                            <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                              {auditValueText(change.from, locale)}
                            </span>
                            {/* Logical, not «→»: the arrow has to point the way
                                the page reads or the change runs backwards. */}
                            <span aria-hidden className="text-muted-foreground">
                              {en ? '→' : '←'}
                            </span>
                            <span className="font-medium">
                              {auditValueText(change.to, locale)}
                            </span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </CollapsibleSection>
  );
}
