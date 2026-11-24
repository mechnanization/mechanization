import { AlertTriangle } from 'lucide-react';
import { type OccupantOwnerLink } from '@/lib/api-client';
import { CellTag } from '@/components/ui/cell-tag';

/**
 * Who a current tenant holds the flat from, as their own card says — in its
 * own column, so an owner and a tenant recorded on the same flat are visibly
 * connected, or visibly not. Co-owners need no mention: they are rows of the
 * same table.
 */
export function OwnerLinkCell({ link, en }: { link: OccupantOwnerLink; en: boolean }) {
  if (link.state === 'NO_CARD') return <CellTag tone="muted">—</CellTag>;

  if (link.state === 'LINKED') return <CellTag>{link.ownerName}</CellTag>;

  if (link.state === 'LINKED_ELSEWHERE') {
    return (
      <CellTag tone="warning" className="whitespace-normal">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        {en
          ? `Linked to ${link.ownerName}, who is not recorded as an owner of this unit`
          : `مربوط بـ${link.ownerName}، وهو غير مسجَّل مالكاً لهذه الوحدة`}
      </CellTag>
    );
  }

  return (
    <CellTag tone="muted" className="whitespace-normal">
      {en ? 'Not linked to an owner' : 'غير مربوط بمالك'}
      {link.typedName ? (en ? ` (named: ${link.typedName})` : ` (ذكر: ${link.typedName})`) : null}
    </CellTag>
  );
}
