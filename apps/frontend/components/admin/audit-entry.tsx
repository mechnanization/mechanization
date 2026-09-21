'use client';

import Link from 'next/link';
import {
  Banknote,
  Building2,
  ClipboardCheck,
  ClipboardList,
  DoorOpen,
  FileText,
  KeyRound,
  Layers,
  Link2,
  LogIn,
  Settings,
  ShieldAlert,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { AuditEntry } from '@/lib/api-client';
import { auditActionLabel, auditEntityLabel } from '@/lib/audit-labels';
import { auditToneOf, describeAudit, type AuditTone } from '@/lib/audit-describe';
import { formatDateTime, formatRelative, formatTime } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { ChangeValue, FactCell, FactRow } from '@/components/ui/facts';

/**
 * One audit entry: what was done, to which record, by whom, when — and what
 * changed, in the words the rest of the portal uses.
 *
 * The action and its record lead, because that is what a reader scans a trail
 * for. The person and the time sit on the line under it, where the eye goes
 * second. Field changes read «قبل ← بعد» in reading order; anything a person
 * wrote (a correction note, a return reason) is quoted as they wrote it;
 * everything else is still one tap away under «كل التفاصيل», so nothing the log
 * holds is hidden, only ordered.
 */

const TONE_CLASS: Record<AuditTone, string> = {
  create: 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  change: 'bg-primary/10 text-primary',
  remove: 'bg-destructive/10 text-destructive',
  review: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  correction: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  money: 'bg-primary/10 text-primary',
  access: 'bg-muted text-muted-foreground',
};

/** The subject's icon; the tone's colour says what kind of act it was. */
function iconOf(action: string): LucideIcon {
  if (action.startsWith('DATA_')) return Wrench;
  if (action.startsWith('RECORD_') || action.startsWith('QUALITY_')) return ClipboardCheck;
  if (action.startsWith('BUILDING_')) return Building2;
  if (action.startsWith('UNIT_') || action.startsWith('OCCUPANCY_')) return DoorOpen;
  if (action.startsWith('CASE_')) return ClipboardList;
  if (action.startsWith('LANDLORD_') || action === 'HOUSEHOLD_LINKED') return Link2;
  if (action.startsWith('CITIZEN_') || action.startsWith('REGISTRATION_') || action === 'TENANCY_ENDED') return Users;
  if (action.startsWith('FEE_') || action.startsWith('PAYMENT_') || action.includes('PAYOUT')) return Banknote;
  if (action.startsWith('ZONE_') || action === 'CADASTRE_IMPORT') return Layers;
  if (action === 'LOGIN') return LogIn;
  if (/TOTP|PASSWORD|EMAIL|STAFF_/.test(action)) return KeyRound;
  if (action === 'DOCUMENT_VIEW' || action === 'CSV_EXPORT') return FileText;
  if (action === 'REGISTER_RESTORED') return ShieldAlert;
  return Settings;
}

/** How many change and fact lines show before the rest fold into «كل التفاصيل». */
const SHOWN_LINES = 6;

export function AuditEntryItem({
  entry,
  locale,
  base,
  compact = false,
}: {
  entry: AuditEntry;
  locale: string;
  /** `/{tenant}/{locale}/{adminPath}` — for links to the record. */
  base: string;
  /** On a record's own trail the record is already known, so its name is not repeated. */
  compact?: boolean;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const tone = auditToneOf(entry.action);
  const Icon = iconOf(entry.action);
  const description = describeAudit(entry, locale);

  const actorKind = entry.actor?.kind ?? (entry.actorType as 'STAFF' | 'CITIZEN' | 'SYSTEM');
  const actorName =
    entry.actor?.name ??
    (actorKind === 'SYSTEM'
      ? en
        ? 'System (manual correction or automatic job)'
        : 'النظام (تصحيح يدوي أو مهمة تلقائية)'
      : actorKind === 'CITIZEN'
        ? en
          ? 'The citizen'
          : 'المواطن'
        : (entry.actor?.email ?? entry.actorEmail ?? (en ? 'Staff account no longer exists' : 'حساب موظف لم يعد موجوداً')));
  const roleLabel = entry.actor?.role
    ? ((labels.staffRole as Record<string, string>)[entry.actor.role] ?? entry.actor.role)
    : null;

  const target = entry.target;
  const href = target?.link ? linkFor(base, target.link) : null;

  const lines = [
    ...description.changes.map((change) => ({ kind: 'change' as const, ...change })),
    ...description.facts.map((fact) => ({ kind: 'fact' as const, ...fact })),
  ];
  const shown = lines.slice(0, SHOWN_LINES);
  const folded = lines.slice(SHOWN_LINES);
  const detailCount = folded.length + description.details.length;

  return (
    <li className="flex gap-3 py-3.5">
      <span
        aria-hidden
        className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', TONE_CLASS[tone])}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">{auditActionLabel(entry.action, locale)}</h3>
          {!compact && target ? (
            target.label ? (
              href ? (
                <Link
                  href={href}
                  className="min-w-0 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {target.label}
                </Link>
              ) : (
                <span className="min-w-0 text-sm font-medium text-foreground/90">{target.label}</span>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                {auditEntityLabel(target.type, locale)}
                {target.missing ? (en ? ' — no longer exists' : ' — لم يعد موجوداً') : ''}
              </span>
            )
          ) : null}
          {!compact && target?.secondary ? (
            <span className="text-xs text-muted-foreground" dir="auto">
              {secondaryLabel(target.secondary, labels)}
            </span>
          ) : null}
          {/*
            `ms-auto` on a wrapper, not on the `<time>`: the time carries its own
            `dir="ltr"`, and a logical margin resolves against the element's own
            direction — on the `<time>` itself `ms-auto` became a *left* margin
            in an Arabic row and held the time against the title instead of
            sending it to the far edge.
          */}
          <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)} dir="ltr">
              {formatTime(entry.createdAt)}
            </time>
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <UserRound className="size-3.5 shrink-0" aria-hidden />
            <span className="font-medium text-foreground/80">{actorName}</span>
            {/* Plain, not a chip: a role is a fact about the actor, and a filled
                pill around it reads as a control on a line of running text. */}
            {roleLabel ? (
              <>
                <span aria-hidden>·</span>
                <span>{roleLabel}</span>
              </>
            ) : null}
            {compact ? null : (
              <>
                <span aria-hidden>·</span>
                <span>{formatRelative(entry.createdAt, locale)}</span>
              </>
            )}
          </p>
          {/* On a record's own trail the line splits: who at the start, how
              long ago at the far edge under the time, so the width is used. */}
          {compact ? <span className="shrink-0">{formatRelative(entry.createdAt, locale)}</span> : null}
        </div>

        {description.quotes.map((quote) => (
          <figure key={`${quote.label}-${quote.value}`} className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <figcaption className="mb-0.5 text-[11px] font-medium text-muted-foreground">{quote.label}</figcaption>
            <blockquote className="leading-relaxed text-foreground">{quote.value}</blockquote>
          </figure>
        ))}

        {/* Rows — the label at the start, its value at the far edge — under a
            rule that separates the facts from the who-and-when above. */}
        {shown.length > 0 ? (
          <FactRow className="border-t border-border/60">
            {shown.map((line) => (
              <Line key={`${line.kind}-${line.label}`} line={line} en={en} />
            ))}
          </FactRow>
        ) : null}

        {detailCount > 0 ? (
          <details className="group text-xs">
            <summary className="w-fit cursor-pointer select-none rounded text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {en ? `All details (${detailCount})` : `كل التفاصيل (${detailCount})`}
            </summary>
            {/* The fold keeps its own surface — it is a panel, not a value. */}
            <FactRow className="mt-2 rounded-lg bg-muted/30 px-3">
              {folded.map((line) => (
                <Line key={`folded-${line.kind}-${line.label}`} line={line} en={en} />
              ))}
              {description.details.map((detail) => (
                <Line key={`detail-${detail.label}`} line={{ kind: 'fact', ...detail }} en={en} />
              ))}
              <FactCell
                label={en ? 'Action code' : 'رمز الإجراء'}
                className="font-mono text-[11px] font-normal text-muted-foreground"
                value={`${entry.action}${entry.entityId ? ` · ${entry.entityType} ${entry.entityId}` : ''}`}
              />
            </FactRow>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function Line({
  line,
  en,
}: {
  line: { kind: 'change'; label: string; before: string; after: string } | { kind: 'fact'; label: string; value: string };
  en: boolean;
}) {
  /*
    `dir="auto"` used to sit on the `<dd>` here, and it is what pulled «X-498-A»
    to the far edge while «مبنى سكني» stayed on the near one — see `FactGrid`,
    which isolates the value with `<bdi>` instead so the column holds.
  */
  const value =
    line.kind === 'change' ? (
      <ChangeValue before={line.before} after={line.after} becameLabel={en ? 'became' : 'أصبح'} />
    ) : (
      line.value
    );
  return <FactCell label={line.label} value={value} />;
}

function linkFor(base: string, link: NonNullable<NonNullable<AuditEntry['target']>['link']>): string {
  const id = encodeURIComponent(link.id);
  switch (link.kind) {
    case 'citizen':
      return `${base}/citizens/${id}`;
    case 'building':
      return `${base}/buildings/${id}/matrix`;
    case 'case':
      return `${base}/cases/${id}/edit`;
    case 'zone':
      return `${base}/zones`;
    case 'staff':
      return `${base}/inspector/profile?inspectorId=${id}`;
  }
}

/** A target's second line can be a staff role or a case type code; say it in words. */
function secondaryLabel(value: string, labels: ReturnType<typeof getLabels>): string {
  return (
    (labels.staffRole as Record<string, string>)[value] ??
    (labels.caseType as Record<string, string>)[value] ??
    (labels.documentType as Record<string, string>)[value] ??
    value
  );
}
