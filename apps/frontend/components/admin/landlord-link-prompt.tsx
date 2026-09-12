'use client';

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import type { LandlordLinkOffers } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  LandlordProposalCard,
  LandlordProposalResolved,
} from '@/components/admin/landlord-proposal-card';

/**
 * The owner question, put at the one moment it can be answered well.
 *
 * A save can turn up a match in either direction, and both land here:
 *
 *  - **`filed`** — this household just named an owner the register already
 *    holds. The officer typed the number seconds ago and the tenant is still in
 *    front of them.
 *  - **`naming`** — this household *is* the owner three other cards have been
 *    naming for months. The officer has the new file open and the claims beside
 *    it.
 *
 * Both are the same question with the arrow pointing different ways, and both
 * are cheapest to settle now. Left alone they go to «روابط المالكين», where
 * somebody with no memory of either household has to reconstruct from two
 * records what one person could have confirmed in a second.
 *
 * ## Why a dialog and not a toast
 *
 * Because it asks for a decision rather than reporting one. `announceCensus`
 * next door is a toast precisely because nothing is being asked — it says what
 * already happened and disappears. A confirmation that decides ownership, moves
 * the matrix and can put units on a bill should not be something an officer can
 * miss by looking away for four seconds.
 *
 * ## Dismissable, and that is not the same as "no"
 *
 * «لاحقاً» closes the dialog and settles nothing. The claims stay open and stay
 * in the queue, which is the honest outcome for an officer who does not know
 * the answer — unlike «ليس الشخص نفسه» on a card, which is a decision and is
 * recorded as one. Conflating the two would have a tired clerk's dismissal read
 * as a considered rejection forever after.
 */
export function LandlordLinkPrompt({
  tenant,
  token,
  offers,
  citizenHref,
  onClose,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  /** Null when the lookup failed — the caller renders nothing at all. */
  offers: LandlordLinkOffers | null;
  citizenHref: (citizenId: string) => string;
  onClose: () => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const [resolved, setResolved] = useState<Record<string, 'linked' | 'dismissed'>>({});

  /*
    Both directions in one list, deduplicated.

    A household can appear on both sides of a single save — they named a
    landlord *and* are named as one — and a card filed by a tenant whose owner
    is the person being edited satisfies `naming` and `filed` simultaneously
    when the two share a registration. Keyed by `propertyEntryId`, which is the
    claim's identity, so one claim is one card however many ways it was found.
  */
  const proposals = [...(offers?.filed ?? []), ...(offers?.naming ?? [])].filter(
    (proposal, index, all) =>
      all.findIndex((other) => other.propertyEntryId === proposal.propertyEntryId) === index,
  );

  if (proposals.length === 0) return null;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-5 text-primary" aria-hidden />
            {en ? 'Owner links found' : 'روابط مالكين محتملة'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? 'A phone number on these records matches a registered citizen. A number is not an identity, so nothing has been linked — confirm only what you recognise.'
              : 'رقم هاتف في هذه السجلات يطابق مواطناً مسجَّلاً. الرقم ليس هوية، لذلك لم يُربط شيء تلقائياً — أكِّد ما تعرفه فقط.'}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto">
          {proposals.map((proposal) =>
            resolved[proposal.propertyEntryId] ? (
              <LandlordProposalResolved
                key={proposal.propertyEntryId}
                outcome={resolved[proposal.propertyEntryId]!}
                locale={locale}
              />
            ) : (
              <LandlordProposalCard
                key={proposal.propertyEntryId}
                tenant={tenant}
                token={token}
                proposal={proposal}
                citizenHref={citizenHref}
                onResolved={(id, outcome) =>
                  setResolved((current) => ({ ...current, [id]: outcome }))
                }
                locale={locale}
              />
            ),
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {/*
              Not «إلغاء». Nothing is being cancelled — the record is saved and
              the claims are untouched — and a button that says otherwise makes
              an officer hesitate over an action that costs nothing.
            */}
            {en ? 'Later' : 'لاحقاً'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
