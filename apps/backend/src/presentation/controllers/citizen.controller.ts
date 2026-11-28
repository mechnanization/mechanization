import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  EVERY_STAFF_ROLE,
  REGISTER_WRITE_ROLES,
  adminCreateCitizenSubmissionSchema,
  adminUpdateCitizenSubmissionSchema,
  citizenImportSchema,
  citizenMergePairSchema,
  citizenMergeSchema,
  citizenUnmergeSchema,
  endOwnershipSchema,
  endTenancySchema,
  possibleDuplicatesQuerySchema,
  setCitizenActiveSchema,
  worklistQuerySchema,
} from '@mechanization/shared-schemas';
import type {
  AdminCitizenSubmission,
  AdminCitizenUpdateSubmission,
  CitizenImportRequest,
  CitizenMergeInput,
  CitizenMergePair,
  CitizenUnmergeInput,
  EndOwnershipInput,
  EndTenancyInput,
  PossibleDuplicatesQuery,
  SetCitizenActive,
  WorklistQuery,
} from '@mechanization/shared-schemas';
import { CitizenMergeService } from '../../application/features/citizens/citizen-merge.service';
import { CitizensService } from '../../application/features/citizens/citizens.service';
import { OwnershipService } from '../../application/features/citizens/ownership.service';
import { AuditService } from '../../application/features/audit/audit.service';
import { TenancyService } from '../../application/features/citizens/tenancy.service';
import { CitizenProfileService, type CitizenProfileUnit } from '../../application/features/reporting/citizen-profile.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { NotFoundError } from '../../application/common/exceptions';
import { citizenArrears } from '../../application/features/fees/bill-arrears';
import { CurrentTenant, CurrentUser } from '../decorators/current-user.decorator';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { SelfService } from '../decorators/self-service.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { UuidPipe } from '../pipes/uuid.pipe';
import { queryLimit, queryOffset } from './query-params';
import { CitizenDuplicatesService } from '../../application/features/citizens/citizen-duplicates.service';
import { CitizenImportService } from '../../application/features/citizens/citizen-import.service';

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
    private readonly profiles: CitizenProfileService,
    private readonly tenancy: TenancyService,
    private readonly ownership: OwnershipService,
    private readonly audit: AuditService,
    private readonly merges: CitizenMergeService,
    private readonly duplicates: CitizenDuplicatesService,
    private readonly imports: CitizenImportService,
  ) {}

  /**
   * «سجل التعديلات» — what was changed on this file, by whom, from what to
   * what, and why. Open to everyone who can open the file; changes only, never
   * who viewed it or how it is being reviewed (see `AuditService.history`).
   */
  @Roles(...EVERY_STAFF_ROLE)
  @Get(':id/history')
  history(@Param('id', new UuidPipe()) id: string, @Query('limit') limit = '30', @Query('offset') offset = '0') {
    return this.audit.history({
      entityType: 'User',
      entityId: id,
      limit: queryLimit(limit, 30, 100),
      offset: queryOffset(offset),
    });
  }

  /**
   * The registry table: every citizen with their registration summary and
   * their fee standing. `search` matches name, phone, رقم مرجعي or document
   * number — the four things a clerk has in front of them.
   */
  @Roles(...EVERY_STAFF_ROLE)
  @Get()
  async list(
    @CurrentActor() actor: StaffActor,
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
    return this.citizens.list(
      {
        search,
        status,
        limit: queryLimit(limit, 200, 500),
        offset: queryOffset(offset),
      },
      // «يتطلب مراجعة» is the viewer's own queue unless they are an admin.
      actor,
    );
  }

  /**
   * «يتطلب مراجعة» — the records filed with fields left «غير مؤكَّد», oldest
   * first, with only what the queue shows: name, mother's name, reference,
   * phone, status and how many fields are open. The same roles as the
   * registry above: the queue is a slice of it and discloses nothing more.
   * Each officer sees the records they filed; admins see everyone's
   * (`seesAllStaffWork`).
   *
   * A static path, declared before `@Get(':id')` so it is not read as an id.
   */
  @Roles(...EVERY_STAFF_ROLE)
  @Get('review-queue')
  reviewQueue(
    @Query(new ZodValidationPipe(worklistQuerySchema)) query: WorklistQuery,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.citizens.reviewQueue(query, actor);
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
  @SelfService("a citizen's own summary; refuses staff")
  @Get('me/summary')
  async mySummary(@CurrentUser() user: SessionClaims) {
    const citizen = await this.profiles.getCitizenProfile(user.sub);
    if (!citizen) throw new NotFoundError('Citizen', user.sub);

    /*
      How a co-owned flat is divided, and this person's part — never another
      owner's register id. Under «مالك مسؤول» their part says whether they pay
      for all (1/1) or nothing (0/1), read the same way as the staff file reads
      it (`lib/owner-billing.ts`).
    */
    const portalOwnerBilling = (billing: CitizenProfileUnit['ownerBilling']) =>
      billing ? { mode: billing.mode, effectiveMode: billing.effectiveMode, share: billing.share } : null;

    return {
      fullName: citizen.fullName,
      referenceNumber: citizen.referenceNumber,
      registeredAt: citizen.registeredAt,
      isActive: citizen.isActive,

      // ── The citizen's own details, so ملفّي can show a profile rather than
      //    just a balance. All of it is theirs; none of it is anyone else's.
      phone: citizen.phone,
      whatsapp: citizen.whatsapp,
      /**
       * اسم الأم وشهرتها — sent for the same reason every other field here is.
       *
       * It is the one identifying answer the register now holds for a Lebanese
       * household (migration 0044), so it is also the one a person should be
       * able to check is *theirs*: a wrong mother's name on a file is how two
       * namesakes get read as one at a counter, and the person who can see the
       * error is the only one who knows it is one. Null means «لم يُسأل».
       */
      motherName: citizen.motherName,
      gender: citizen.gender,
      nationality: citizen.nationality,
      isLebanese: citizen.isLebanese,
      residentStatus: citizen.residentStatus,
      maritalStatus: citizen.maritalStatus,
      bloodType: citizen.bloodType,
      totalRegisteredMembers: citizen.totalRegisteredMembers,
      actualHouseholdMembers: citizen.actualHouseholdMembers,
      identityDocType: citizen.identityDocType,

      /**
       * نوع الملف, and what goes with it for somebody who lives elsewhere.
       *
       * A «غير مقيم في البلدة» record holds a name, a phone, a town and
       * possibly a local contact — and ملفّي rendered none of those, so the one
       * person who could tell the municipality that the number for the cousin
       * holding their keys had changed was shown a page that did not mention
       * them. Null on a household file, where `Detail` drops the row.
       */
      residence: citizen.residence,
      residencePlace: citizen.residencePlace,
      localContactName: citizen.localContactName,
      localContactPhone: citizen.localContactPhone,

      /**
       * Which of their own fields the register could not establish — the paths
       * only, never the officer's reason for each.
       *
       * A citizen who can see «رقم الهاتف» on this list is a citizen who can
       * bring it to the counter, which is the only way most of these get
       * filled. The reason stays behind: it is a note one officer wrote to the
       * next about a household («الجيران قالوا إنهم سافروا»), and it is neither
       * addressed to the household nor always something to read back to them.
       */
      unestablishedFields: [
        ...new Set(
          citizen.registrations.flatMap((registration) =>
            registration.flags.map((flag) => flag.path),
          ),
        ),
      ],

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
      /*
        Without the link's identifiers. The owner's *name* is the tenant's to
        see — it is who they pay — but the owner's register id and رقم مرجعي
        are somebody else's, and the reference number alone opens that person's
        own portal.
      */
      properties: citizen.registrations
        .flatMap((registration) => registration.properties)
        // What they hold now: a tenancy that ended is not a property they have.
        .filter((property) => !property.endedAt)
        .map(({ landlordCitizenId: _id, landlordReferenceNumber: _reference, heldUnits, ...property }) => ({
          ...property,
          /*
            A منزل's flat, or the census flats a مبنى card bills through — the
            same split, the same rule. Absent on a profile cached before it.
          */
          heldUnits: (heldUnits ?? []).map(({ ownerBilling, ...unit }) => ({
            ...unit,
            ownerBilling: portalOwnerBilling(ownerBilling),
          })),
          // The owners' names and أسهم are the tenant's to see; their register
          // ids and numbers — their own or a relative's — are not: the
          // landlord's number is on the card. Named, so a field added to the
          // staff view never reaches the portal by default.
          units: property.units.map(({ ownerBilling, ...unit }) => ({
            ...unit,
            owners: unit.owners.map((owner) => ({ name: owner.name, shares: owner.shares })),
            ownerBilling: portalOwnerBilling(ownerBilling),
          })),
        })),
      // Each bill's `request` (0092) is the citizen's own: its number, type and status, as «طلباتي» shows them.
      // An old debt's line goes with the old books' reference cleared: it is the municipality's own bookkeeping (task 10).
      payments: citizen.payments.map((payment) => ({ ...payment, arrears: citizenArrears(payment.arrears) })),
      fees: citizen.fees,
    };
  }

  /**
   * What ending this tenancy would touch — which flats, whether anybody else
   * still lives in each, who owns them — so «إنهاء الإيجار» asks the right
   * questions before anything is pressed.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Get('tenancies/:propertyEntryId/end-preview')
  tenancyEndPreview(@Param('propertyEntryId', new UuidPipe()) propertyEntryId: string) {
    return this.tenancy.previewCard(propertyEntryId);
  }

  /**
   * «إنهاء الإيجار» from the tenant's file: the card and its flats end — kept as
   * history, lease included — the owner stays owner, and the flat gets the
   * status the officer gives it. The same operation the unit matrix runs.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Post('tenancies/:propertyEntryId/end')
  endTenancy(
    @Param('propertyEntryId', new UuidPipe()) propertyEntryId: string,
    @Body(new ZodValidationPipe(endTenancySchema)) body: EndTenancyInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.tenancy.endCard(
      propertyEntryId,
      {
        reason: body.reason,
        endedAt: body.endedAt,
        rowIds: body.rowIds,
        unitIds: body.unitIds,
        afterStatus: body.afterStatus,
        vacancyBasis: body.vacancyBasis,
        vacancyNotes: body.vacancyNotes,
      },
      actor,
    );
  }

  /**
   * What ending this ownership would touch — which flats, whether a co-owner
   * keeps each, whether the seller lived there, which tenants' links name them
   * — so «إنهاء الملكية» asks only what applies.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Get('ownerships/:propertyEntryId/end-preview')
  ownershipEndPreview(@Param('propertyEntryId', new UuidPipe()) propertyEntryId: string) {
    return this.ownership.previewCard(propertyEntryId);
  }

  /**
   * «إنهاء الملكية» from the owner's file: sold (the card stays as history,
   * the buyer recorded or asked for) or recorded in error. The same operation
   * the unit matrix runs for an owner's spell.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Post('ownerships/:propertyEntryId/end')
  endOwnership(
    @Param('propertyEntryId', new UuidPipe()) propertyEntryId: string,
    @Body(new ZodValidationPipe(endOwnershipSchema)) body: EndOwnershipInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.ownership.endCard(
      propertyEntryId,
      {
        reason: body.reason,
        endedAt: body.endedAt,
        rowIds: body.rowIds,
        newOwnerId: body.newOwnerId,
        afterStatus: body.afterStatus,
        vacancyBasis: body.vacancyBasis,
        vacancyNotes: body.vacancyNotes,
      },
      actor,
    );
  }

  /**
   * Who is registered on one رقم العقار.
   *
   * Sits above `:id` because Nest matches in declaration order and `parcel`
   * would otherwise be read as a citizen id — the same reasoning `citizens/new`
   * and `citizens/queue` already follow on the frontend router.
   */
  @Roles(...EVERY_STAFF_ROLE)
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
  @Roles(...EVERY_STAFF_ROLE)
  @Get(':id')
  async getById(@Param('id', new UuidPipe()) id: string) {
    const citizen = await this.profiles.getCitizenProfile(id);
    if (!citizen) throw new NotFoundError('Citizen', id);
    return citizen;
  }

  /**
   * The citizen's record shaped back into the form that edits it — the same
   * three sections `PATCH` expects, so the edit page loads and posts the same
   * object rather than mapping between two shapes.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Get(':id/form')
  async getEditable(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.citizens.getEditable(id, user.sub);
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
  @Roles(...REGISTER_WRITE_ROLES)
  @Post()
  async create(
    @CurrentTenant('slug') tenantSlug: string,
    @Body(new ZodValidationPipe(adminCreateCitizenSubmissionSchema))
    payload: AdminCitizenSubmission,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.citizens.create({
      tenantSlug,
      payload,
      actor,
    });
  }

  /**
   * «هل هو مسجَّل مسبقاً؟» — the question `create` would refuse on, asked
   * without writing anything.
   *
   * The form calls this before it creates a structure the household asked for,
   * so a filing that turns out to be somebody already on file leaves nothing
   * half-made behind. Same body and same roles as `create`: it is that
   * endpoint's first step, not a lookup anyone else needs.
   *
   * A static path declared before any `:id` route, for the reason `import`
   * gives.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Post('duplicate-review')
  async duplicateReview(
    @Body(new ZodValidationPipe(adminCreateCitizenSubmissionSchema))
    payload: AdminCitizenSubmission,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.duplicates.reviewDuplicates(payload, { id: user.sub });
  }

  /**
   * «قد يكون مسجَّلاً مسبقاً» while the form is typed — the save's own rule on
   * what has been typed so far (`CitizenDuplicatesService.possibleDuplicates`). Same
   * roles as `create` and `update`, the two forms that show it.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Post('possible-duplicates')
  async possibleDuplicates(
    @Body(new ZodValidationPipe(possibleDuplicatesQuerySchema)) query: PossibleDuplicatesQuery,
  ) {
    return this.duplicates.possibleDuplicates(query);
  }

  /**
   * «دمج ملفين» — what folding one file into another would do, read-only.
   *
   * SUPER_ADMIN only, like the merge itself: the preview names every bill,
   * flat and officer's credit the merge would touch, which is the decision's
   * whole content.
   */
  @Roles('SUPER_ADMIN')
  @Post('merge/preview')
  async mergePreview(@Body(new ZodValidationPipe(citizenMergePairSchema)) pair: CitizenMergePair) {
    return this.merges.preview(pair);
  }

  /**
   * «دمج ملفين». SUPER_ADMIN only — it rewrites whose a filing, a bill and a
   * flat are, and the launch-day merge of three brothers is what it looks like
   * decided by anyone else. Refused if either file moved since the preview.
   */
  @Roles('SUPER_ADMIN')
  @Post('merge')
  async merge(
    @CurrentTenant('slug') tenantSlug: string,
    @Body(new ZodValidationPipe(citizenMergeSchema)) body: CitizenMergeInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.merges.merge({ ...body, tenantSlug, actor });
  }

  /**
   * The file this one was folded into, and the files folded into it — the
   * profile's «دُمج في» / «دُمج فيه» notes. Open to everyone who can open the
   * file: a clerk who lands on a merged record needs to be sent to the live one.
   */
  @Roles(...EVERY_STAFF_ROLE)
  @Get(':id/merges')
  async mergesOf(@Param('id', new UuidPipe()) id: string) {
    return this.merges.mergesOf(id);
  }

  /** Whether «التراجع عن الدمج» would go through, and if not, why. */
  @Roles('SUPER_ADMIN')
  @Get('merges/:mergeId/undo-preview')
  async unmergePreview(@Param('mergeId', new UuidPipe()) mergeId: string) {
    return this.merges.unmergePreview(mergeId);
  }

  /** «التراجع عن الدمج» — refused once either file has changed since the merge. */
  @Roles('SUPER_ADMIN')
  @Post('merges/:mergeId/undo')
  async unmerge(
    @CurrentTenant('slug') tenantSlug: string,
    @Param('mergeId', new UuidPipe()) mergeId: string,
    @Body(new ZodValidationPipe(citizenUnmergeSchema)) body: CitizenUnmergeInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.merges.unmerge({
      mergeId,
      reason: body.reason,
      tenantSlug,
      actor,
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
  @Roles(...REGISTER_WRITE_ROLES)
  @Post('import')
  async import(
    @CurrentTenant('slug') tenantSlug: string,
    @Body(new ZodValidationPipe(citizenImportSchema)) payload: CitizenImportRequest,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.imports.importMany({
      tenantSlug,
      rows: payload.rows,
      startRow: payload.startRow,
      dryRun: payload.dryRun,
      actor,
    });
  }

  /**
   * «مراجعة التعديلات» — the same edit `PATCH` takes, read and never written:
   * what it changes, what else it touches, what would refuse it, and whether
   * it needs a reason. The form shows it before the officer presses save.
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Post(':id/edit-review')
  async reviewEdit(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(adminUpdateCitizenSubmissionSchema))
    payload: AdminCitizenUpdateSubmission,
  ) {
    return this.citizens.reviewEdit(id, payload);
  }

  /** A clerk correcting a citizen already on file. */
  @Roles(...REGISTER_WRITE_ROLES)
  @Patch(':id')
  async update(
    @CurrentTenant('slug') tenantSlug: string,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(adminUpdateCitizenSubmissionSchema))
    payload: AdminCitizenUpdateSubmission,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.citizens.update({
      tenantSlug,
      citizenId: id,
      payload,
      actor,
    });
  }

  /**
   * «أرشفة الملف» and its undo — there is no route that deletes a citizen
   * (decision, 2026-10-05). An archived citizen keeps every row they own and
   * is skipped by the fee biller; archiving requires a reason and who asked
   * (`setCitizenActiveSchema`).
   */
  @Roles(...REGISTER_WRITE_ROLES)
  @Patch(':id/active')
  async setActive(
    @CurrentTenant('slug') tenantSlug: string,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(setCitizenActiveSchema)) body: SetCitizenActive,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.citizens.setActive({
      tenantSlug,
      citizenId: id,
      isActive: body.isActive,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.requestedBy ? { requestedBy: body.requestedBy } : {}),
      ...(body.movedOn ? { movedOn: body.movedOn } : {}),
      actor,
    });
  }
}
