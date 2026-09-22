'use client';

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
  useLandlordResolutions,
} from '@/components/admin/landlord-proposal-card';

/**
 * The owner question, put at the one moment it can be answered well.
 *
 * A save can turn up a match in either direction, and both land here:
 *
 *  - **`filed`** — this household just named an owner the register already
 *    holds. The officer typed the number seconds ago and the tenant is still in
 *    front of them.
 *  - **`naming`** — this household *is* the owner other cards have been naming
 *    for months. This is how the register learns an owner has arrived after
 *    their tenants: their save asks, by the numbers they answer on.
 *
 * Both are the same card as «روابط المالكين», so the question reads the same
 * wherever it is met. Left unanswered they stay on that queue.
 *
 * ## Dismissable, and that is not the same as «no»
 *
 * «لاحقاً» closes the dialog and settles nothing. «لا أحد منهم» on a card is a
 * decision and is recorded as one. Conflating the two would have a tired
 * clerk's dismissal read as a considered rejection forever after.
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
  const { resolved, resolve, undo, undoing } = useLandlordResolutions({ tenant, token, locale });

  /*
    Both directions in one list, deduplicated by the claim's own id — a card
    filed by a tenant whose owner is the person being edited satisfies both.
  */
  const proposals = [...(offers?.filed ?? []), ...(offers?.naming ?? [])].filter(
    (proposal, index, all) =>
      all.findIndex((other) => other.propertyEntryId === proposal.propertyEntryId) === index,
  );

  if (proposals.length === 0) return null;

  const open = proposals.filter((proposal) => !resolved[proposal.propertyEntryId]).length;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-5 text-primary" aria-hidden />
            {en ? 'Is this the owner?' : 'هل هذا هو المالك؟'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? 'A number on this record belongs to a registered citizen. A phone is not an identity, so nothing was linked — choose only a person you recognise.'
              : 'رقم في هذا السجل يعود لمواطن مسجَّل. الرقم ليس هوية، لذلك لم يُربط شيء — اختر فقط شخصاً تعرفه.'}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[60dvh] space-y-3 overflow-y-auto px-1">
          {proposals.map((proposal) => {
            const resolution = resolved[proposal.propertyEntryId];
            return resolution ? (
              <LandlordProposalResolved
                key={proposal.propertyEntryId}
                resolution={resolution}
                onUndo={() => void undo(resolution)}
                undoing={undoing === proposal.propertyEntryId}
                locale={locale}
              />
            ) : (
              <LandlordProposalCard
                key={proposal.propertyEntryId}
                tenant={tenant}
                token={token}
                proposal={proposal}
                citizenHref={citizenHref}
                onResolved={resolve}
                locale={locale}
              />
            );
          })}
        </div>

        <DialogFooter>
          <Button variant={open === 0 ? 'default' : 'outline'} onClick={onClose} className="h-11 sm:h-10">
            {/*
              Not «إلغاء». Nothing is being cancelled — the record is saved and
              any unanswered claim stays on the queue.
            */}
            {open === 0 ? (en ? 'Done' : 'تم') : en ? 'Later' : 'لاحقاً'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
