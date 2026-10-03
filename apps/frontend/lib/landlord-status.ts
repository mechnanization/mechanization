import { CircleSlash, Link2, UserSearch, Users, type LucideIcon } from 'lucide-react';
import type { LandlordProposal } from '@/lib/api-client';

/**
 * Where one owner claim stands — said the same way on the «روابط المالكين»
 * table and on its «فحص الرابط» page.
 *
 *  - `READY` — one person on the card's number: choose and link.
 *  - `SEVERAL` — a shared line, more than one registered person on it: the
 *    clerk has to say which.
 *  - `NAME_ONLY` — found by the typed name alone, never by number: the weaker
 *    match, never preselected.
 *  - `BLOCKED` — no link can be made yet, whoever the owner is (the card is
 *    not on the survey, the flat is vacant…); the server's sentence says what
 *    unblocks it.
 */
export type LandlordLinkStatus = 'READY' | 'SEVERAL' | 'NAME_ONLY' | 'BLOCKED';

export function landlordLinkStatus(proposal: LandlordProposal): LandlordLinkStatus {
  const linkable = proposal.candidates.filter((candidate) => !candidate.blocked);
  if (proposal.blocked || linkable.length === 0) return 'BLOCKED';
  if (proposal.candidates.length > 1) return 'SEVERAL';
  if (proposal.candidates[0]?.matchedBy === 'NAME') return 'NAME_ONLY';
  return 'READY';
}

/**
 * The status's word, icon and tone. A word and an icon, never colour alone
 * (COL-3). `primary` for the one that is simply ready — pointed at, not warned
 * about; `warning` for the ones that want a decision or a prior step.
 */
export function landlordLinkStatusView(
  status: LandlordLinkStatus,
  locale: string,
): { label: string; icon: LucideIcon; tone: 'primary' | 'warning' } {
  const en = locale === 'en';
  switch (status) {
    case 'READY':
      return { label: en ? 'Ready to link' : 'جاهز للربط', icon: Link2, tone: 'primary' };
    case 'SEVERAL':
      return { label: en ? 'Several people — choose' : 'عدة مرشحين — اختر', icon: Users, tone: 'warning' };
    case 'NAME_ONLY':
      return { label: en ? 'Matched by name only' : 'مطابقة بالاسم فقط', icon: UserSearch, tone: 'warning' };
    case 'BLOCKED':
      return { label: en ? 'Cannot link yet' : 'لا يمكن الربط بعد', icon: CircleSlash, tone: 'warning' };
  }
}
