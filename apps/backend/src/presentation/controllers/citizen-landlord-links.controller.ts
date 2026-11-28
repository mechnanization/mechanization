import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  EVERY_STAFF_ROLE,
  LANDLORD_LINK_ANSWER_ROLES,
  LANDLORD_SUMMARY_READ_ROLES,
  REGISTER_WRITE_ROLES,
  confirmLandlordLinkSchema,
  landlordLinkCandidatesSchema,
} from '@mechanization/shared-schemas';
import type { ConfirmLandlordLink, LandlordLinkCandidates } from '@mechanization/shared-schemas';
import { LandlordLinkService } from '../../application/features/citizens/landlord-link.service';
import { LandlordLinkQueueService } from '../../application/features/citizens/landlord-link-queue.service';
import { LandlordUnlinkService } from '../../application/features/citizens/landlord-unlink.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { NotFoundError } from '../../application/common/exceptions';
import { StaffActor } from '../../application/common/actor';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import { queryLimit, queryOffset } from './query-params';

/**
 * «روابط المالكين»: the queue of tenancy cards whose landlord number matches a
 * registered citizen, and the answers to it — confirm, dismiss, restore, unlink.
 *
 * Its own controller since audit GOD-13 (2026-11-27), out of `CitizenController`,
 * on the same paths and with the same roles.
 */
@Controller('t/:tenantSlug/citizens')
export class CitizenLandlordLinksController {
  constructor(
    private readonly landlordLinkService: LandlordLinkService,
    private readonly linkQueue: LandlordLinkQueueService,
    private readonly unlinks: LandlordUnlinkService,
  ) {}

  // ──────────────────  Owner links (روابط المالكين)  ──────────────────
  //
  // Mounted on the same `citizens` path as `CitizenController`, and registered
  // before it in `PresentationModule` for the reason `parcel` is declared above
  // `:id` there: Nest matches in registration order, and `landlord-links` would
  // otherwise be read as a citizen id (pinned by `citizen-routes-order.spec.ts`).
  //
  // Everything here is about identifying the owner a مستأجر named, among the
  // register's own citizens — see `LandlordLinkService` for why the match is
  // computed rather than stored, and why nothing links itself.

  /**
   * The queue: every unresolved claim whose number matches a registered
   * citizen.
   *
   * Readable by the roles that read the register, because it is a view of the
   * register. Acting on one is a narrower list — see `confirmLandlordLink`.
   */
  @Roles(...EVERY_STAFF_ROLE)
  @Get('landlord-links')
  landlordLinks(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    /*
      Paged, because the match is: one statement finds only the claims that
      resolve to somebody, and the page is hydrated from those. The whole queue
      in one response was the read this screen used to make on every visit.
    */
    return this.linkQueue.proposals({
      limit: queryLimit(limit, 20, 100),
      offset: queryOffset(offset),
    });
  }

  /**
   * How much ownership the register knows about and does not bill.
   *
   * Split out from the queue rather than folded into it because it answers a
   * different person's question: the queue is a clerk's afternoon, this is the
   * number somebody takes to the council. See `unbilledOwnedUnits`.
   */
  @Roles(...LANDLORD_SUMMARY_READ_ROLES)
  @Get('landlord-links/summary')
  landlordLinkSummary() {
    return this.linkQueue.unbilledOwnedUnits();
  }

  /**
   * The form's inline lookup: who is registered on this number?
   *
   * Every active citizen on it. A shared household line is where the officer
   * standing with the tenant is best placed to say which person was meant, so
   * the form lists them to choose from rather than falling silent. `candidate`
   * is kept for a client from before the list existed: the one person, or null
   * where there are several.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Get('landlord-links/candidate')
  async landlordCandidate(@Query('phone') phone?: string) {
    if (!phone?.trim()) return { candidate: null, candidates: [] };
    const candidates = await this.linkQueue.candidatesFor(phone);
    return { candidate: candidates.length === 1 ? candidates[0] : null, candidates };
  }

  /**
   * «فحص الرابط» — one open claim, as the queue row it was opened from: the
   * same roles as the queue, which it is a view of. 404 when the claim is no
   * longer open (linked, dismissed, ended, or naming nobody registered).
   *
   * Declared after the static `landlord-links/*` reads so neither is read as
   * an id; a non-UUID is refused by `UuidPipe` before the database is asked.
   */
  @Roles(...EVERY_STAFF_ROLE)
  @Get('landlord-links/:propertyEntryId')
  async landlordLink(@Param('propertyEntryId', new UuidPipe()) propertyEntryId: string) {
    const proposal = await this.linkQueue.proposal(propertyEntryId);
    if (!proposal) throw new NotFoundError('LandlordLink', propertyEntryId);
    return proposal;
  }

  /**
   * What «إلغاء الربط» would do, read when its confirmation opens — so the
   * clerk is told which flats leave the owner's file, and whether bills have
   * been raised since, before deciding.
   */
  @Roles(...LANDLORD_LINK_ANSWER_ROLES)
  @Get('landlord-links/:propertyEntryId/unlink-preview')
  landlordUnlinkPreview(@Param('propertyEntryId', new UuidPipe()) propertyEntryId: string) {
    return this.unlinks.unlinkPreview(propertyEntryId);
  }

  /**
   * «نعم، هذا هو المالك» — the only writer of `landlordCitizenId`.
   *
   * Gated to the roles accountable for the register rather than to every
   * reader, because this decides money: a confirmed link records ownership,
   * shows the owner on the matrix, and can put units on a bill. AUDITOR sees
   * the queue and does not answer it, which is the read-only remit its name
   * implies.
   *
   * The service re-checks that the number actually matches the citizen before
   * writing, so a request naming an arbitrary pair is refused rather than
   * recorded as a confirmed match.
   */
  @Roles(...LANDLORD_LINK_ANSWER_ROLES)
  @Post('landlord-links/:propertyEntryId/confirm')
  confirmLandlordLink(
    @Param('propertyEntryId', new UuidPipe()) propertyEntryId: string,
    @Body(new ZodValidationPipe(confirmLandlordLinkSchema)) body: ConfirmLandlordLink,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.landlordLinkService.confirm({
      propertyEntryId,
      citizenId: body.citizenId,
      actor,
    });
  }

  /**
   * «لا أحد منهم» — these citizens are not this card's owner.
   *
   * Names the citizens the clerk was shown, so somebody registering on the
   * number later is still offered. See `landlordLinkDismissedIds`.
   */
  @Roles(...LANDLORD_LINK_ANSWER_ROLES)
  @Post('landlord-links/:propertyEntryId/dismiss')
  dismissLandlordLink(
    @Param('propertyEntryId', new UuidPipe()) propertyEntryId: string,
    @Body(new ZodValidationPipe(landlordLinkCandidatesSchema)) body: LandlordLinkCandidates,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.landlordLinkService.dismiss({
      propertyEntryId,
      candidateIds: body.candidateIds,
      actor,
    });
  }

  /** The «تراجع» on a dismissal — offers those citizens on the card again. */
  @Roles(...LANDLORD_LINK_ANSWER_ROLES)
  @Post('landlord-links/:propertyEntryId/restore')
  restoreLandlordLink(
    @Param('propertyEntryId', new UuidPipe()) propertyEntryId: string,
    @Body(new ZodValidationPipe(landlordLinkCandidatesSchema)) body: LandlordLinkCandidates,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.landlordLinkService.undismiss({
      propertyEntryId,
      candidateIds: body.candidateIds,
      actor,
    });
  }

  /**
   * Undoes a confirmation: the claim goes back to the queue, and what the link
   * wrote into the owner's records — occupancies, unit rows, a card it created
   * — is reverted, exactly that and only while unedited. See
   * `LandlordUnlinkService.unlink` for what is kept and why.
   */
  @Roles(...LANDLORD_LINK_ANSWER_ROLES)
  @Delete('landlord-links/:propertyEntryId')
  unlinkLandlord(
    @Param('propertyEntryId', new UuidPipe()) propertyEntryId: string,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.unlinks.unlink({
      propertyEntryId,
      actor,
    });
  }
}
