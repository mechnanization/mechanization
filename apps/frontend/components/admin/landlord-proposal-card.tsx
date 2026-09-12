'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeftRight,
  Building2,
  Check,
  FileText,
  Loader2,
  Phone,
  TriangleAlert,
  UserCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  ApiRequestError,
  confirmLandlordLink,
  dismissLandlordLink,
  logApiError,
  type LandlordProposal,
} from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * One unresolved owner claim, shaped as the question it actually asks.
 *
 * ## Why this is a comparison and not a list
 *
 * The officer is not reading a record; they are answering **«هل هذان الاسمان
 * لشخص واحد؟»** on the strength of a phone number a third party typed. Laid out
 * as a column of labelled lines — filed by, named owner, phone, parcel, units —
 * that question has to be reassembled in the reader's head from facts scattered
 * down the card, and the two names that decide it end up four lines apart.
 *
 * So the card is built around the comparison: the name the tenant gave on one
 * side, the registered citizen's name on the other, and the number that is the
 * only thing joining them on the hinge between. Two spellings of one name is a
 * yes; two different names on one line is a shared household and almost
 * certainly a no. That judgment is now one glance instead of one reconstruction.
 *
 * ## Why the evidence is shown once, in the middle
 *
 * Printing the number under each side would suggest two facts agreeing. There
 * is one fact, it belongs to neither record more than the other, and its
 * weakness — a household shares a line — is the entire reason a person is being
 * asked rather than a matcher deciding. Putting it on the hinge says that.
 *
 * ## What the consequences line is for
 *
 * A confirmation writes an `OWNER` occupancy on every flat the card names and,
 * where the owner has filed nothing on that structure, a property card on their
 * file — which is what puts it on a bill. That is too much to discover
 * afterwards from a toast, so it is stated before the button, in the numbers it
 * will actually move.
 */
export function LandlordProposalCard({
  tenant,
  token,
  proposal,
  citizenHref,
  onResolved,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  proposal: LandlordProposal;
  /** How this screen routes to a citizen's file — the admin path differs. */
  citizenHref: (citizenId: string) => string;
  /** Told what happened, so the list can drop the row it just settled. */
  onResolved: (propertyEntryId: string, outcome: 'linked' | 'dismissed') => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const confirm = async (citizenId: string) => {
    if (busy) return;
    setBusy(citizenId);
    try {
      const result = await confirmLandlordLink(tenant, token, proposal.propertyEntryId, citizenId);

      /*
        Each half said only when it happened.

        A confirmation does up to three things and none is guaranteed: the
        occupancies land only where the tenant's card named canonical units, and
        the owner's card is minted only where they had filed nothing on that
        structure. A fixed message would claim all three every time, and the one
        that matters most — «أُضيف العقار إلى ملفه», because that is what puts it
        on a bill — is precisely the one sometimes absent.
      */
      const parts = [
        result.occupanciesRecorded > 0
          ? en
            ? `Recorded as owner on ${result.occupanciesRecorded} unit(s).`
            : `سُجِّل كمالك على ${result.occupanciesRecorded} وحدة.`
          : null,
        result.ownerCardCreated
          ? en
            ? 'The property was added to their own file.'
            : 'أُضيف العقار إلى ملفه.'
          : null,
      ].filter(Boolean);

      toast.success(en ? 'Owner linked' : 'تم ربط المالك', {
        description:
          parts.length > 0
            ? parts.join(' ')
            : en
              ? 'The claim is resolved. Nothing else needed recording.'
              : 'تم حسم المطالبة. لا شيء آخر يحتاج إلى تسجيل.',
      });
      onResolved(proposal.propertyEntryId, 'linked');
    } catch (caught) {
      logApiError(caught);
      toast.error(
        caught instanceof ApiRequestError
          ? caught.payload.message
          : en
            ? 'Could not link the owner.'
            : 'تعذّر ربط المالك.',
      );
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy('dismiss');
    try {
      await dismissLandlordLink(tenant, token, proposal.propertyEntryId);
      onResolved(proposal.propertyEntryId, 'dismissed');
    } catch (caught) {
      logApiError(caught);
      toast.error(en ? 'Could not dismiss it.' : 'تعذّر استبعاد المطابقة.');
    } finally {
      setBusy(null);
    }
  };

  const ambiguous = proposal.candidates.length > 1;
  const sole = ambiguous ? null : proposal.candidates[0]!;

  const where = [
    proposal.buildingName,
    proposal.propertyNumber
      ? en
        ? `Parcel ${proposal.propertyNumber}`
        : `العقار ${proposal.propertyNumber}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="overflow-hidden rounded-xl border border-border/80 bg-card">
      {/* ── Where the claim came from ──────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-muted/20 px-3.5 py-2.5">
        <Badge variant="soft-muted" className="gap-1">
          <FileText className="size-3 shrink-0" aria-hidden />
          {proposal.occupancyType === 'FREE_OCCUPANT'
            ? en
              ? 'Free occupant'
              : 'شاغل بتسامح'
            : en
              ? 'Tenant'
              : 'مستأجر'}
        </Badge>

        {proposal.filedBy ? (
          <Link
            href={citizenHref(proposal.filedBy.citizenId)}
            className="text-sm font-medium underline-offset-4 hover:text-primary hover:underline"
          >
            {proposal.filedBy.name}
          </Link>
        ) : (
          <span className="text-sm font-medium">
            {en ? 'A registered household' : 'أسرة مسجَّلة'}
          </span>
        )}

        {where ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Building2 className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{where}</span>
          </span>
        ) : null}
      </header>

      {/* ── The comparison this card exists to put ──────────────────── */}
      <div className="px-3.5 py-3.5">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
          <ComparisonSide
            label={en ? 'Named as the owner' : 'الاسم المذكور كمالك'}
            name={proposal.landlordName ?? (en ? 'Not named' : 'بلا اسم')}
            muted={!proposal.landlordName}
            tone="neutral"
          />

          {/*
            The hinge: the one fact joining the two sides, and the reason a
            person rather than a matcher is being asked.

            Rotated on desktop and upright on mobile because the comparison
            itself rotates — two columns become two stacked blocks, and an
            arrow pointing sideways between vertically stacked things reads as
            a decoration rather than as a relation.
          */}
          <div className="flex items-center justify-center gap-2 sm:flex-col sm:px-1">
            <ArrowLeftRight
              className="size-3.5 shrink-0 text-muted-foreground/70 sm:rotate-90"
              aria-hidden
            />
            <span
              dir="ltr"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 font-mono text-xs font-medium tabular-nums"
            >
              <Phone className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              {proposal.landlordPhone}
            </span>
          </div>

          {ambiguous ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-start gap-1.5 text-xs font-medium leading-relaxed">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                {en
                  ? `${proposal.candidates.length} citizens are registered on this number`
                  : `${proposal.candidates.length} مواطنين مسجَّلين على هذا الرقم`}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {en
                  ? 'A shared household line. Check the name against the one on the left before choosing.'
                  : 'خط منزل مشترك. قارن الاسم بالاسم المذكور قبل الاختيار.'}
              </p>
            </div>
          ) : (
            <ComparisonSide
              label={en ? 'Registered citizen' : 'مواطن مسجَّل'}
              name={sole!.name}
              reference={sole!.referenceNumber}
              tone="match"
            />
          )}
        </div>

        {/*
          What pressing the button actually does to the register.

          Both halves are conditional and both are named, because an officer
          should not learn from a toast that a property has just appeared on
          somebody's file. Where neither applies the line still renders — "this
          only resolves the claim" is itself the information.
        */}
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <UserCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            {[
              proposal.linkedUnitCount > 0
                ? en
                  ? `Records them as owner on ${proposal.linkedUnitCount} surveyed unit(s).`
                  : `يسجّله كمالك على ${proposal.linkedUnitCount} وحدة ممسوحة.`
                : null,
              en
                ? 'Adds the property to their own file if they have not filed it.'
                : 'ويضيف العقار إلى ملفه إن لم يكن قد سجّله.',
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
        </p>
      </div>

      {/* ── The two answers ─────────────────────────────────────────── */}
      <footer className="flex flex-col gap-2 border-t border-border/60 bg-muted/10 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {proposal.candidates.map((candidate) => (
            <Button
              key={candidate.id}
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => void confirm(candidate.id)}
            >
              {busy === candidate.id ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <UserCheck className="size-4" aria-hidden />
              )}
              {ambiguous
                ? en
                  ? `Link ${candidate.name}`
                  : `اربط ${candidate.name}`
                : en
                  ? 'Yes, same person'
                  : 'نعم، الشخص نفسه'}
            </Button>
          ))}
        </div>

        <Button
          size="sm"
          variant="ghost"
          disabled={Boolean(busy)}
          onClick={() => void dismiss()}
          className="text-muted-foreground hover:text-foreground"
        >
          {busy === 'dismiss' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <X className="size-4" aria-hidden />
          )}
          {en ? 'Not the same person' : 'ليس الشخص نفسه'}
        </Button>
      </footer>
    </article>
  );
}

/**
 * One name in the comparison, with the label that says whose it is.
 *
 * Both sides share a shape so the eye compares the names rather than the
 * layouts; only the tint differs, and only on the side the register vouches
 * for. A `border` and no shadow, because the card around it already carries the
 * one elevation on screen.
 */
function ComparisonSide({
  label,
  name,
  reference,
  muted = false,
  tone,
}: {
  label: string;
  name: string;
  reference?: string | null;
  /** A claim with no name on it — rendered as the absence it is. */
  muted?: boolean;
  tone: 'neutral' | 'match';
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg border p-3',
        tone === 'match' ? 'border-primary/30 bg-primary/[0.05]' : 'border-border/70 bg-muted/20',
      )}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <UserRound className="size-3 shrink-0" aria-hidden />
        {label}
      </p>
      <p
        className={cn(
          'mt-1 truncate text-sm font-semibold',
          muted ? 'font-normal text-muted-foreground' : 'text-foreground',
        )}
        title={name}
      >
        {name}
      </p>
      {reference ? (
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground" dir="ltr">
          {reference}
        </p>
      ) : null}
    </div>
  );
}

/** The tick shown in place of a card the officer has just settled. */
export function LandlordProposalResolved({
  outcome,
  locale = 'ar',
}: {
  outcome: 'linked' | 'dismissed';
  locale?: string;
}) {
  const en = locale === 'en';
  return (
    <p
      className={cn(
        'flex items-center gap-2 rounded-xl border border-dashed px-3.5 py-3 text-xs',
        outcome === 'linked'
          ? 'border-success/40 bg-success/5 text-foreground'
          : 'border-border text-muted-foreground',
      )}
    >
      {outcome === 'linked' ? (
        <Check className="size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <X className="size-4 shrink-0" aria-hidden />
      )}
      {outcome === 'linked'
        ? en
          ? 'Owner linked, and the property added to their file.'
          : 'تم ربط المالك وإضافة العقار إلى ملفه.'
        : en
          ? 'Dismissed — it will not be proposed again.'
          : 'تم الاستبعاد — لن تُقترح هذه المطابقة مرة أخرى.'}
    </p>
  );
}
