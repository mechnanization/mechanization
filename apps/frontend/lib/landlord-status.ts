import { Building2, CircleSlash, Link2, UserSearch, Users, type LucideIcon } from 'lucide-react';
import type { LandlordProposal, LandlordProposalCandidate } from '@/lib/api-client';
import { compareNames, type NameMatch } from '@/lib/landlord-display';

/**
 * Where one owner claim stands — said the same way on the «روابط المالكين»
 * table and on its «فحص الرابط» page.
 *
 *  - `READY` — the card's number is one registered person's (or, on a shared
 *    household line, the name picks out one of them): the number is the
 *    evidence, and the row can link it (`phoneLinkable`).
 *  - `SEVERAL` — a shared line the name does not settle: the clerk has to say
 *    which.
 *  - `NAME_ONLY` — found by the typed name alone, never by number: the weaker
 *    match, never preselected.
 *  - `BY_PROPERTY` — the occupant did not know the owner's number; these are
 *    the property's registered owners. Checked on «فحص», never linked from
 *    the row.
 *  - `BLOCKED` — no link can be made yet, whoever the owner is (the card is
 *    not on the survey, the flat is vacant…); the server's sentence says what
 *    unblocks it.
 */
export type LandlordLinkStatus = 'READY' | 'SEVERAL' | 'NAME_ONLY' | 'BY_PROPERTY' | 'BLOCKED';

export function landlordLinkStatus(proposal: LandlordProposal): LandlordLinkStatus {
  const linkable = proposal.candidates.filter((candidate) => !candidate.blocked);
  if (proposal.blocked || linkable.length === 0) return 'BLOCKED';
  if (phoneLinkable(proposal)) return 'READY';
  if (linkable.some((candidate) => candidate.matchedBy === 'PHONE')) return 'SEVERAL';
  if (linkable.some((candidate) => candidate.matchedBy === 'NAME')) return 'NAME_ONLY';
  return 'BY_PROPERTY';
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
    case 'BY_PROPERTY':
      return {
        label: en ? 'Property’s registered owner — no number given' : 'مالك العقار المسجَّل — لم يُذكر رقم',
        icon: Building2,
        tone: 'warning',
      };
    case 'BLOCKED':
      return { label: en ? 'Cannot link yet' : 'لا يمكن الربط بعد', icon: CircleSlash, tone: 'warning' };
  }
}

/** One light: a word and its colour (never colour alone, COL-3). */
export interface MatchLight {
  tone: 'success' | 'warning' | 'destructive' | 'muted';
  label: string;
}

const NAME_RANK: Record<NameMatch, number> = { SAME: 0, SIMILAR: 1, OTHER_SCRIPT: 2, DIFFERENT: 3, MISSING: 4 };

/**
 * The registered person a row is compared against: the strongest of the
 * claim's candidates — found by the number before found by the name alone,
 * then the closest name, then one a link can be made to. The rest are on
 * «فحص الرابط»; the row says how many.
 */
export function bestCandidate(proposal: LandlordProposal): LandlordProposalCandidate | null {
  const ranked = [...proposal.candidates].sort((a, b) => {
    const byPhone = Number(a.matchedBy !== 'PHONE') - Number(b.matchedBy !== 'PHONE');
    if (byPhone) return byPhone;
    const byName =
      NAME_RANK[compareNames(proposal.landlordName, a.name)] - NAME_RANK[compareNames(proposal.landlordName, b.name)];
    if (byName) return byName;
    return Number(Boolean(a.blocked)) - Number(Boolean(b.blocked));
  });
  return ranked[0] ?? null;
}

/**
 * The one person the row may link without opening «فحص», or null.
 *
 * Only on the number: a phone the occupant gave that is this person's phone
 * or WhatsApp is the evidence that settles it. On a household line shared by
 * several registered people the number alone does not say which, so the
 * typed name has to pick out exactly one of them — the same or a similar
 * name, strictly closer than everyone else's on that number. Anything found
 * by the name alone, or by the property, is checked on «فحص».
 */
export function phoneLinkable(proposal: LandlordProposal): LandlordProposalCandidate | null {
  if (proposal.blocked) return null;
  const onNumber = proposal.candidates.filter((candidate) => candidate.matchedBy === 'PHONE' && !candidate.blocked);
  if (onNumber.length <= 1) return onNumber[0] ?? null;
  const rank = (candidate: LandlordProposalCandidate) => NAME_RANK[compareNames(proposal.landlordName, candidate.name)];
  const [first, second] = [...onNumber].sort((a, b) => rank(a) - rank(b));
  return rank(first!) <= NAME_RANK.SIMILAR && rank(first!) < rank(second!) ? first! : null;
}

/**
 * The name the occupant gave against the registered person's, by the
 * folding the decision card compares with (`compareNames`):
 * green «مطابق» — the same name; orange «مشابه» — the same person written
 * differently, shortened or with the father's name; red «مختلف». Grey when
 * there is nothing to compare: no name given, or two scripts to read.
 */
export function nameLight(proposal: LandlordProposal, candidate: LandlordProposalCandidate, locale: string): MatchLight {
  const en = locale === 'en';
  switch (compareNames(proposal.landlordName, candidate.name)) {
    case 'SAME':
      return { tone: 'success', label: en ? 'Matches' : 'مطابق' };
    case 'SIMILAR':
      return { tone: 'warning', label: en ? 'Similar' : 'مشابه' };
    case 'DIFFERENT':
      return { tone: 'destructive', label: en ? 'Different' : 'مختلف' };
    case 'OTHER_SCRIPT':
      return { tone: 'muted', label: en ? 'Compare by reading' : 'قارن بنفسك' };
    case 'MISSING':
      return { tone: 'muted', label: en ? 'Not given' : 'لم يُذكر' };
  }
}

/**
 * The number the occupant gave against the registered person: green when it
 * is theirs (they were found by it), red when it is not (found by the name
 * alone). Grey when no number was given — missing is not a mismatch.
 */
export function phoneLight(proposal: LandlordProposal, candidate: LandlordProposalCandidate, locale: string): MatchLight {
  const en = locale === 'en';
  if (!proposal.landlordPhone) return { tone: 'muted', label: en ? 'Not given' : 'لم يُذكر' };
  return candidate.matchedBy === 'PHONE'
    ? { tone: 'success', label: en ? 'Matches' : 'مطابق' }
    : { tone: 'destructive', label: en ? 'Different' : 'غير مطابق' };
}

/**
 * Whether the occupant's card was filed before the owner was registered —
 * the case this queue exists for: nobody to link to when the occupant came,
 * the owner registered since.
 */
export function filedBeforeOwner(proposal: LandlordProposal, candidate: LandlordProposalCandidate): boolean {
  return Boolean(candidate.registeredAt && new Date(proposal.filedAt) < new Date(candidate.registeredAt));
}
