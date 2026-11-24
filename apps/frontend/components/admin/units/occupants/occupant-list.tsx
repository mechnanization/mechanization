import { useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Building2, EllipsisVertical, UserRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { type UnitOccupant, type UnitWithOccupants } from '@/lib/api-client';
import { ACTION_TINT } from '@/lib/action-tint';
import { formatDate } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { ActionTooltip } from '@/components/ui/tooltip';
import { EndOwnershipDialog } from '@/components/admin/end-ownership-dialog';
import { unitOwners } from '../../building-unit-forms';
import { EndOccupancyDialog, endActionLabel, type EndOccupancyAnswer } from './end-occupancy-dialog';
import { OwnerLinkCell } from './owner-link-cell';
import { LinkOwnerDialog } from './link-owner-dialog';

/**
 * Everyone recorded against a unit, current first — shared by the drawer and
 * the full-page matrix so the two cannot disagree about what ending a spell
 * asks, or which history rows are shown.
 *
 * The end action lives behind a ⋯ menu with a finger-sized target, away from
 * the name link it used to sit beside, and opens `EndOccupancyDialog` rather
 * than acting. Spells ended «سُجِّل بالخطأ» are left out of the list — they are
 * not history — and counted underneath so nothing disappears silently.
 */
export function OccupantList({
  unit,
  locale,
  canWrite,
  busy,
  citizenHref,
  onEnd,
  onLinkOwner,
  session,
  onOwnershipEnded,
  compact = false,
}: {
  unit: UnitWithOccupants;
  locale: string;
  canWrite: boolean;
  busy: boolean;
  /** One card per person at every width — for a narrow side panel. */
  compact?: boolean;
  /** Where a name links to; plain text when absent. */
  citizenHref?: (citizenId: string) => string;
  onEnd: (occupant: UnitOccupant, input: EndOccupancyAnswer) => Promise<void>;
  /**
   * The staff session «إنهاء الملكية» reads and writes with. An owner's row
   * opens `EndOwnershipDialog`, which asks what happened, who the new owner
   * is and who lives there now — more than a reason and a date — so it talks
   * to the server itself and reports back through `onOwnershipEnded`.
   */
  session?: { tenant: string; token: string };
  /** An ownership on this unit ended; the matrix should read the unit again. */
  onOwnershipEnded?: () => void;
  /**
   * «ربط بالمالك» — links a tenant to one of the flat's owners. `confirmRecordedAfter`
   * is the officer's confirmation for an owner recorded after the tenant. Throws
   * to report a refusal.
   */
  onLinkOwner?: (occupant: UnitOccupant, ownerId: string, confirmRecordedAfter: boolean) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [ending, setEnding] = useState<UnitOccupant | null>(null);
  const [linking, setLinking] = useState<UnitOccupant | null>(null);
  const owners = unitOwners(unit);
  /** The flat's owners a tenant may be linked to — anyone but themselves. */
  const ownersFor = (occupant: UnitOccupant) =>
    owners.filter((owner) => owner.citizenId !== occupant.citizenId);

  const shown = unit.occupants.filter((occupant) => occupant.endReason !== 'RECORDED_IN_ERROR');
  const hidden = unit.occupants.length - shown.length;
  const tableLabels = useTableLabels();

  /*
    Columns only some flats need are left out where no row would fill them:
    a tenant-only flat has no أسهم to show, and a flat with no current tenant
    has nobody to be linked to an owner. A column of dashes is noise (UX-3).
  */
  const showShares = shown.some((occupant) => occupant.shares);
  const showOwnerLink = shown.some(
    (occupant) =>
      occupant.toDate === null && occupant.ownerLink && occupant.ownerLink.state !== 'NO_CARD',
  );
  const showActions = canWrite && shown.some((occupant) => occupant.toDate === null);

  const columns = useMemo<ColumnDef<UnitOccupant>[]>(() => {
    const nameOf = (occupant: UnitOccupant) => occupant.citizenName ?? (en ? 'Unnamed' : 'بلا اسم');
    const list: ColumnDef<UnitOccupant>[] = [
      {
        id: 'name',
        header: en ? 'Name' : 'الاسم',
        meta: { mobile: 'primary' },
        cell: ({ row }) => {
          const occupant = row.original;
          const current = occupant.toDate === null;
          const nameClass = cn(
            'inline-flex min-w-0 items-center gap-1.5 text-sm',
            current ? 'font-medium' : 'text-muted-foreground',
          );
          const body = (
            <>
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate" title={nameOf(occupant)}>
                {nameOf(occupant)}
              </span>
            </>
          );
          return citizenHref ? (
            <Link
              href={citizenHref(occupant.citizenId)}
              className={cn(nameClass, 'underline-offset-2 hover:underline')}
            >
              {body}
            </Link>
          ) : (
            <span className={nameClass}>{body}</span>
          );
        },
      },
      {
        id: 'role',
        header: en ? 'Capacity' : 'الصفة',
        cell: ({ row }) => <CellTag>{labels.occupancyRole[row.original.role]}</CellTag>,
      },
      /*
        The number, beside the name, for owner and occupant alike: the officer
        at the door is the person who needs to call whoever is recorded here,
        and opening each file to find it was the detour.
      */
      {
        id: 'phone',
        header: en ? 'Phone' : 'الهاتف',
        cell: ({ row }) =>
          row.original.citizenPhone ? (
            <a
              href={`tel:${row.original.citizenPhone}`}
              dir="ltr"
              className="whitespace-nowrap text-xs tabular-nums text-primary underline-offset-2 hover:underline"
            >
              {formatPhone(row.original.citizenPhone)}
            </a>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
    ];

    if (showShares) {
      list.push({
        id: 'shares',
        header: en ? 'Shares' : 'الأسهم',
        cell: ({ row }) =>
          row.original.shares ? (
            <CellTag className="tabular-nums">
              {en ? `${row.original.shares}/2400` : `${row.original.shares}/2400 سهم`}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      });
    }

    list.push(
      {
        id: 'period',
        header: en ? 'Period' : 'المدّة',
        cell: ({ row }) => (
          <CellTag tone="muted" className="tabular-nums">
            {row.original.toDate
              ? `${formatDate(row.original.fromDate)} — ${formatDate(row.original.toDate)}`
              : `${en ? 'Since' : 'منذ'} ${formatDate(row.original.fromDate)}`}
          </CellTag>
        ),
      },
      {
        id: 'status',
        header: en ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const occupant = row.original;
          if (occupant.toDate !== null) {
            return (
              <CellTag tone="muted">
                {en ? 'Former' : 'سابق'}
                {occupant.endReason ? ` · ${labels.occupancyEndReason[occupant.endReason]}` : null}
              </CellTag>
            );
          }
          /*
            No card on their file claims this flat — so billing, which reads
            the file, has nothing to charge for it. Only said of a current
            spell: a former one released on the way out is missing nothing.
          */
          if (occupant.backedByFile === false) {
            return (
              <CellTag
                tone="warning"
                title={
                  en
                    ? 'This citizen has no registration, so nothing on their file claims this unit and it cannot be billed. Register them to link it.'
                    : 'لا يوجد ملف لهذا المواطن، فلا شيء يربطه بالوحدة ولن تُحتسب الرسوم. سجّله ليُربط العقار.'
                }
              >
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {en ? 'No file yet' : 'لا ملف له بعد'}
              </CellTag>
            );
          }
          return <CellTag tone="success">{en ? 'Current' : 'حالي'}</CellTag>;
        },
      },
    );

    if (showOwnerLink) {
      list.push({
        id: 'owner',
        header: en ? 'Rents from' : 'المؤجِّر',
        cell: ({ row }) =>
          row.original.toDate === null && row.original.ownerLink ? (
            <OwnerLinkCell link={row.original.ownerLink} en={en} />
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      });
    }

    if (citizenHref || showActions) {
      list.push({
        id: 'actions',
        // Blank header: DataTable pins it to the card footer on a phone.
        header: '',
        meta: { align: 'end', mobile: 'actions', headerClassName: 'w-36' },
        cell: ({ row }) => {
          const occupant = row.original;
          const name = nameOf(occupant);
          const canEnd = showActions && occupant.toDate === null;
          /*
            The same two doors, in the same dress, as the citizens register's
            row (UX-1): the file, and the properties and units on it.
          */
          return (
            <div className="flex items-center justify-end gap-1.5">
              {citizenHref ? (
                <>
                  <ActionTooltip label={en ? 'View details & invoices' : 'عرض التفاصيل والفواتير'}>
                    <Link
                      href={citizenHref(occupant.citizenId)}
                      aria-label={en ? `View ${name}'s details` : `عرض تفاصيل ${name}`}
                      className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), ACTION_TINT.view)}
                    >
                      <UserRound className="size-4" aria-hidden />
                    </Link>
                  </ActionTooltip>
                  <ActionTooltip label={en ? 'Properties & units' : 'العقارات والوحدات'}>
                    <Link
                      href={`${citizenHref(occupant.citizenId)}/properties`}
                      aria-label={en ? `${name}'s properties & units` : `عقارات ووحدات ${name}`}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                        ACTION_TINT.properties,
                      )}
                    >
                      <Building2 className="size-4" aria-hidden />
                    </Link>
                  </ActionTooltip>
                </>
              ) : null}
              {canEnd ? occupantMenu(occupant, name) : null}
            </div>
          );
        },
      });
    }

    return list;
    // `occupantMenu` reads `owners`, which is derived from `unit` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [en, labels, citizenHref, showShares, showOwnerLink, showActions, busy, onLinkOwner, unit]);

  /**
   * ⋮ — the writes on one current spell: link to an owner, end it. A render
   * function, not a component: declared in here it would remount every render.
   */
  function occupantMenu(occupant: UnitOccupant, name: string) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={en ? `Actions for ${name}` : `إجراءات ${name}`}
            className="text-muted-foreground"
          >
            <EllipsisVertical className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/*
            Offered to a tenant whose card names no registered owner,
            whenever the flat has an owner recorded. An owner recorded
            after the tenant is linked only once the officer confirms
            it in the dialog.
          */}
          {onLinkOwner &&
          occupant.role !== 'OWNER' &&
          occupant.ownerLink &&
          (occupant.ownerLink.state === 'UNLINKED' || occupant.ownerLink.state === 'NO_CARD') &&
          ownersFor(occupant).length > 0 ? (
            <DropdownMenuItem className="min-h-10" onSelect={() => setLinking(occupant)}>
              {en ? 'Link to the owner…' : 'ربط بالمالك…'}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-10 text-destructive focus:text-destructive"
            onSelect={() => setEnding(occupant)}
          >
            {endActionLabel(occupant.role, en)}…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (unit.occupants.length === 0) return null;

  return (
    <>
      {shown.length > 0 ? (
        <section className="space-y-2" aria-labelledby={`occupants-${unit.id}`}>
          <h3 id={`occupants-${unit.id}`} className="text-sm font-semibold">
            {en ? 'Registered in this unit' : 'المسجَّلون في الوحدة'}
            <span className="ms-1.5 font-normal tabular-nums text-muted-foreground">({shown.length})</span>
          </h3>
          <DataTable
            columns={columns}
            data={shown}
            labels={tableLabels}
            getRowId={(occupant) => occupant.id}
            searchable={false}
            sortable={false}
            paginated={false}
            fixedLayout
            layout={compact ? 'cards' : 'responsive'}
          />
        </section>
      ) : null}

      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">
          {en
            ? `${hidden} entr${hidden === 1 ? 'y' : 'ies'} recorded in error — kept, not shown.`
            : `${hidden} إشغال سُجِّل بالخطأ — محفوظ ولا يُعرض.`}
        </p>
      ) : null}

      {session && ending?.role === 'OWNER' ? (
        <EndOwnershipDialog
          tenant={session.tenant}
          token={session.token}
          source={{ kind: 'occupancy', occupancyId: ending.id }}
          open
          onOpenChange={(open) => {
            if (!open) setEnding(null);
          }}
          onEnded={() => onOwnershipEnded?.()}
          locale={locale}
        />
      ) : null}

      <EndOccupancyDialog
        occupant={session && ending?.role === 'OWNER' ? null : ending}
        unitCode={unit.unitCode}
        asksStatus={
          Boolean(ending) &&
          ending!.role !== 'OWNER' &&
          !unit.occupants.some(
            // The server's rule: another person, not another row of the same one.
            (other) =>
              other.citizenId !== ending!.citizenId && other.toDate === null && other.role !== 'OWNER',
          )
        }
        locale={locale}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        onConfirm={(input) => onEnd(ending!, input)}
      />

      {onLinkOwner ? (
        <LinkOwnerDialog
          occupant={linking}
          owners={linking ? ownersFor(linking) : []}
          unitCode={unit.unitCode}
          locale={locale}
          onOpenChange={(open) => {
            if (!open) setLinking(null);
          }}
          onConfirm={(ownerId, confirmRecordedAfter) => onLinkOwner(linking!, ownerId, confirmRecordedAfter)}
        />
      ) : null}
    </>
  );
}
