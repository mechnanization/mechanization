import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  adminCreateCitizenSubmissionSchema,
  adminUpdateCitizenSubmissionSchema,
  citizenImportSchema,
} from '@mechanization/shared-schemas';
import type {
  AdminCitizenSubmission,
  AdminCitizenUpdateSubmission,
  CitizenImportRequest,
} from '@mechanization/shared-schemas';
import { CitizensService } from '../../application/features/citizens/citizens.service';
import { LandlordLinkService } from '../../application/features/citizens/landlord-link.service';
import { ReportingService } from '../../application/features/reporting/reporting.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { NotFoundError } from '../../application/common/exceptions';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * Shows only the tail of an identifier — `•••567`.
 *
 * Enough for someone to recognise their own document, useless to anyone who
 * found their reference number. Short values are hidden entirely rather than
 * partially revealed: masking three of four characters discloses most of it.
 */
function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 3) return '•••';
  return `•••${trimmed.slice(-3)}`;
}

/**
 * Staff-facing citizen registry — read, create, correct, remove.
 *
 * Mounted under the tenant path like everything else, so `TenantMiddleware`
 * resolves the municipality and `JwtAuthGuard` rejects a token issued for a
 * different one before this controller runs. There is deliberately no
 * un-scoped `/citizens/:id` route: an id alone would not say which
 * municipality's schema to read, and the tenant boundary in this system is the
 * database connection rather than a WHERE clause.
 *
 * Read is open to every staff role — an inspector standing at a property needs
 * to know who filed for it. Writing is not: since the public wizard was
 * removed from the landing page, creating a citizen here is the act that puts
 * someone on the municipality's registry, and it carries their identity
 * document. That belongs to the roles accountable for the register, so the
 * write routes are SUPER_ADMIN, FIELD_INSPECTOR and ADMINISTRATIVE_OFFICER
 * (the inspector who moves claims through review, and the clerk whose job is
 * the register itself); AUDITOR keeps the read-only remit its name implies,
 * and so do COLLECTOR and ACCOUNTANT, who need to find a citizen to bill them
 * but have no business editing who is on the register.
 */
@Controller('t/:tenantSlug/citizens')
export class CitizenController {
  constructor(
    private readonly citizens: CitizensService,
    private readonly reporting: ReportingService,
    private readonly landlordLinkService: LandlordLinkService,
  ) {}

  /**
   * The registry table: every citizen with their registration summary and
   * their fee standing. `search` matches name, phone, رقم مرجعي or document
   * number — the four things a clerk has in front of them.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get()
  async list(
    @Query('search') search?: string,
    @Query('limit') limit = '200',
    @Query('offset') offset = '0',
    /**
     * `REQUIRES_REVIEW` narrows the registry to records filed with fields left
     * «غير مؤكَّد». Any other value simply matches nothing rather than being
     * rejected — this is a view the table offers, not an assertion about the
     * request, and a stale bookmark should show an empty registry rather than
     * a 400.
     */
    @Query('status') status?: string,
  ) {
    return this.citizens.list({
      search,
      status,
      limit: Number(limit) || 200,
      offset: Number(offset) || 0,
    });
  }

  /**
   * The signed-in citizen's own record: their properties and their fees.
   *
   * Deliberately **not** `@Roles`-guarded — those decorators list *staff*
   * roles, and a citizen's token carries none, so adding one here would lock
   * out the only people this route is for. `JwtAuthGuard` still applies, and
   * the scoping is `user.sub` in the query rather than a check afterwards, so
   * there is no id to tamper with.
   *
   * This replaces `GET /registrations/mine`, which reported the status of each
   * طلب. What is left that a citizen can act on is what they own and what they
   * owe.
   */
  @Get('me/summary')
  async mySummary(@CurrentUser() user: SessionClaims) {
    const citizen = await this.reporting.getCitizenProfile(user.sub);
    if (!citizen) throw new NotFoundError('Citizen', user.sub);

    return {
      fullName: citizen.fullName,
      referenceNumber: citizen.referenceNumber,
      registeredAt: citizen.registeredAt,
      isActive: citizen.isActive,

      // ── The citizen's own details, so ملفّي can show a profile rather than
      //    just a balance. All of it is theirs; none of it is anyone else's.
      phone: citizen.phone,
      whatsapp: citizen.whatsapp,
      gender: citizen.gender,
      nationality: citizen.nationality,
      isLebanese: citizen.isLebanese,
      residentStatus: citizen.residentStatus,
      maritalStatus: citizen.maritalStatus,
      bloodType: citizen.bloodType,
      totalRegisteredMembers: citizen.totalRegisteredMembers,
      actualHouseholdMembers: citizen.actualHouseholdMembers,
      marriedChildrenCount: citizen.marriedChildrenCount,
      identityDocType: citizen.identityDocType,

      /**
       * Masked to its last three characters, and deliberately not sent whole.
       *
       * The portal's front door now opens on a رقم مرجعي alone — a number
       * printed on every وصل — so whatever this response carries is what a
       * found receipt discloses. The citizen already knows their own ID number;
       * showing the tail is enough to confirm the municipality holds the right
       * document, while a full national ID number on this page would be the
       * single most valuable thing to lift from it.
       */
      identityDocNumberMasked: mask(citizen.identityDocNumber),
      civilRecordNumberMasked: mask(citizen.civilRecordNumber),
      // Flattened: a citizen has no reason to care that their four properties
      // arrived in two separate filings — that grouping was an artefact of the
      // submission workflow, which no longer exists.
      properties: citizen.registrations.flatMap((registration) => registration.properties),
      payments: citizen.payments,
      fees: citizen.fees,
    };
  }

  // ──────────────────  Owner links (روابط المالكين)  ──────────────────
  //
  // Declared above `:id` for the reason `parcel` is: Nest matches in
  // declaration order, and `landlord-links` would otherwise be read as a
  // citizen id.
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
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('landlord-links')
  landlordLinks() {
    return this.landlordLinkService.proposals();
  }

  /**
   * How much ownership the register knows about and does not bill.
   *
   * Split out from the queue rather than folded into it because it answers a
   * different person's question: the queue is a clerk's afternoon, this is the
   * number somebody takes to the council. See `unbilledOwnedUnits`.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('landlord-links/summary')
  landlordLinkSummary() {
    return this.landlordLinkService.unbilledOwnedUnits();
  }

  /**
   * The form's inline lookup: is this number one of ours?
   *
   * Answers at most one citizen and deliberately says nothing where several
   * share the number — the shared-household case, where picking would be
   * guessing. The queue shows all of them to a person instead.
   */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Get('landlord-links/candidate')
  async landlordCandidate(@Query('phone') phone?: string) {
    if (!phone?.trim()) return { candidate: null };
    return { candidate: await this.landlordLinkService.candidateFor(phone) };
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
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER')
  @Post('landlord-links/:propertyEntryId/confirm')
  confirmLandlordLink(
    @Param('propertyEntryId') propertyEntryId: string,
    @Body('citizenId') citizenId: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.landlordLinkService.confirm({
      propertyEntryId,
      citizenId,
      actor: { id: user.sub, role: user.role ?? 'STAFF' },
    });
  }

  /** «ليس هو» — what lets the queue shrink. See `landlordLinkDismissedAt`. */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER')
  @Post('landlord-links/:propertyEntryId/dismiss')
  dismissLandlordLink(
    @Param('propertyEntryId') propertyEntryId: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.landlordLinkService.dismiss({
      propertyEntryId,
      actor: { id: user.sub, role: user.role ?? 'STAFF' },
    });
  }

  /**
   * Undoes a confirmation, putting the claim back in the queue.
   *
   * The correction path for the one mistake this feature can make — the wrong
   * person confirmed off a shared household line. It does not withdraw the
   * occupancies the link recorded; ending a spell is `endOccupancy`'s job on
   * the matrix, which records who ended it and when.
   */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER')
  @Delete('landlord-links/:propertyEntryId')
  unlinkLandlord(
    @Param('propertyEntryId') propertyEntryId: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.landlordLinkService.unlink({
      propertyEntryId,
      actor: { id: user.sub, role: user.role ?? 'STAFF' },
    });
  }

  /**
   * Who is registered on one رقم العقار.
   *
   * Sits above `:id` because Nest matches in declaration order and `parcel`
   * would otherwise be read as a citizen id — the same reasoning `citizens/new`
   * and `citizens/queue` already follow on the frontend router.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('parcel/:propertyNumber')
  parcelRoster(@Param('propertyNumber') propertyNumber: string) {
    return this.citizens.parcelRoster(propertyNumber);
  }

  /**
   * Every staff role reads this: an inspector standing at the property needs
   * to know who filed for it, and a collector at the door needs to know whom
   * they are billing. The identity numbers on this response are the reason the
   * route is role-gated at all rather than open to any session.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get(':id')
  async getById(@Param('id') id: string) {
    const citizen = await this.reporting.getCitizenProfile(id);
    if (!citizen) throw new NotFoundError('Citizen', id);
    return citizen;
  }

  /**
   * The citizen's record shaped back into the form that edits it — the same
   * three sections `PATCH` expects, so the edit page loads and posts the same
   * object rather than mapping between two shapes.
   */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Get(':id/form')
  async getEditable(@Param('id') id: string) {
    return this.citizens.getEditable(id);
  }

  /**
   * A clerk filing a citizen and their first registration, from paper — or a
   * field officer's phone delivering one it recorded with no signal.
   *
   * One route for both, because they are the same act: the schema validates a
   * submission with no flags exactly as strictly as it ever did, and a
   * submission that carries them is held to every rule except the ones the
   * officer named a reason for. A second, laxer endpoint would be a second
   * place for "what counts as a registration" to be decided.
   */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Post()
  async create(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(adminCreateCitizenSubmissionSchema))
    payload: AdminCitizenSubmission,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.citizens.create({
      tenantSlug,
      payload,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  /**
   * Bulk import from a spreadsheet.
   *
   * Same roles as `create` — this is that endpoint applied many times, and
   * gating it more tightly would only push a clerk into pasting rows one at a
   * time through a route they already have.
   *
   * Declared **before** `@Patch(':id')` and alongside the other static paths so
   * it is matched as a literal: registered after a `:id` route, Nest would read
   * `import` as an id and this would never be reached.
   */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Post('import')
  async import(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(citizenImportSchema)) payload: CitizenImportRequest,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.citizens.importMany({
      tenantSlug,
      rows: payload.rows,
      startRow: payload.startRow,
      dryRun: payload.dryRun,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  /** A clerk correcting a citizen already on file. */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Patch(':id')
  async update(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(adminUpdateCitizenSubmissionSchema))
    payload: AdminCitizenUpdateSubmission,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.citizens.update({
      tenantSlug,
      citizenId: id,
      payload,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  /**
   * Soft delete and its undo. A deactivated citizen keeps every row they own
   * and is simply skipped by the fee biller — which is what an inspector
   * wants for someone who has moved away, as against erasing them.
   */
  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Patch(':id/active')
  async setActive(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.citizens.setActive({
      tenantSlug,
      citizenId: id,
      isActive: isActive !== false,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  /**
   * Permanent, and cascades to everything the citizen owns. SUPER_ADMIN only:
   * this erases identity data and registration history in one call, which is
   * not a decision to leave with the role that exists to inspect properties.
   * The service additionally refuses it for anyone with a settled payment.
   */
  @Roles('SUPER_ADMIN')
  @Delete(':id')
  async remove(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.citizens.remove({
      tenantSlug,
      citizenId: id,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }
}
