import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  buildingFilterSchema,
  confirmVacancySchema,
  createBuildingSchema,
  createDamageAssessmentSchema,
  endOccupancySchema,
  endVacancySchema,
  logVisitSchema,
  unitBlueprintSchema,
  updateBuildingSchema,
  updateUnitSchema,
  upsertOccupancySchema,
  upsertUnitSchema,
  type BuildingFilter,
  type ConfirmVacancyInput,
  type CreateBuildingInput,
  type CreateDamageAssessmentInput,
  type EndOccupancyInput,
  type EndVacancyInput,
  type LogVisitInput,
  type UnitBlueprint,
  type UpdateBuildingInput,
  type UpdateUnitInput,
  type UpsertOccupancyInput,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import { BuildingsService } from '../../application/features/buildings/buildings.service';
import { DamageService } from '../../application/features/buildings/damage.service';
import { TenancyService } from '../../application/features/citizens/tenancy.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * The building census.
 *
 * Sits under `t/:tenantSlug` like every other tenant-scoped controller — that
 * prefix is what `TenantMiddleware` binds to, so a route outside it would run
 * with no tenant-scoped Prisma client at all.
 *
 * **Reads are open to every staff role.** A building's code and survey state is
 * what a collector needs to find a door and an accountant needs to read an
 * invoice's breakdown; withholding it would only send them to ask someone else.
 *
 * **Writes are the field roles plus the administrative one**, matching
 * `CasesController` exactly rather than `ZonesController`: creating a building
 * and logging a case are the same afternoon's work by the same people. AUDITOR
 * and ACCOUNTANT are read-only here as they are everywhere in the register.
 *
 * **Deletion is SUPER_ADMIN only**, matching zones — it is the one write that
 * cannot be corrected by doing it again, and the service refuses it outright
 * once anyone has been recorded as living in the building.
 */
const READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ACCOUNTANT',
  'ADMINISTRATIVE_OFFICER',
] as const;

const WRITE_ROLES = [
  'SUPER_ADMIN',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ADMINISTRATIVE_OFFICER',
] as const;

@Controller('t/:tenantSlug/buildings')
export class BuildingsController {
  constructor(
    private readonly buildings: BuildingsService,
    private readonly damage: DamageService,
    private readonly tenancy: TenancyService,
  ) {}

  private actor(user: SessionClaims) {
    return { id: user.sub, role: user.role ?? '' };
  }

  /** The census ledger — filters compose, and every one of them is optional. */
  @Roles(...READ_ROLES)
  @Get()
  async list(@Query(new ZodValidationPipe(buildingFilterSchema)) query: BuildingFilter) {
    return this.buildings.list(query);
  }

  /** One building with its whole unit matrix and each unit's occupants. */
  @Roles(...READ_ROLES)
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.buildings.get(id);
  }

  /**
   * Every observation ever recorded about this structure, newest first —
   * including its units' own readings, since "top three floors gone, ground
   * floor shop still trading" is two rows about one building.
   */
  @Roles(...READ_ROLES)
  @Get(':id/damage')
  async damageHistory(@Param('id') id: string) {
    const [current, history] = await Promise.all([
      this.damage.currentLevel(id),
      this.damage.history(id),
    ]);
    return { current, history };
  }

  @Roles(...WRITE_ROLES)
  @Post()
  async create(
    @Body(new ZodValidationPipe(createBuildingSchema)) body: CreateBuildingInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.create(body, this.actor(user));
  }

  @Roles(...WRITE_ROLES)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBuildingSchema)) body: UpdateBuildingInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.update(id, body, this.actor(user));
  }

  @Roles('SUPER_ADMIN')
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionClaims) {
    await this.buildings.remove(id, this.actor(user));
    return { deleted: true };
  }

  // ───────────────────────────  The unit matrix  ───────────────────────────

  /**
   * Fills the matrix from a blueprint. Additive and idempotent — a floor that
   * already holds the requested number of units is topped up to it, never
   * doubled, so a re-tap on a slow connection cannot invent flats.
   */
  @Roles(...WRITE_ROLES)
  @Post(':id/units/generate')
  async generateUnits(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(unitBlueprintSchema)) body: UnitBlueprint,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.generateUnits(id, body, this.actor(user));
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/units')
  async addUnit(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(upsertUnitSchema)) body: UpsertUnitInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.addUnit(id, body, this.actor(user));
  }

  /**
   * Corrects one unit. Not nested under its building: a unit id is unique on
   * its own, and requiring the building in the path would let a caller pass a
   * pair that disagree — which the handler would then have to decide about.
   */
  @Roles(...WRITE_ROLES)
  @Patch('units/:unitId')
  async updateUnit(
    @Param('unitId') unitId: string,
    @Body(new ZodValidationPipe(updateUnitSchema)) body: UpdateUnitInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.updateUnit(unitId, body, this.actor(user));
  }

  /**
   * Removes a flat the matrix says exists and the street does not.
   *
   * Not nested under its building for the same reason `PATCH` is not. Held to
   * `WRITE_ROLES` rather than `SUPER_ADMIN` — unlike deleting a whole building,
   * this is a survey correction an officer makes standing in the stairwell, and
   * the service refuses it the moment anything has been recorded against the
   * unit. The narrowing that matters is in the guards, not the role.
   */
  @Roles(...WRITE_ROLES)
  @Delete('units/:unitId')
  async deleteUnit(@Param('unitId') unitId: string, @CurrentUser() user: SessionClaims) {
    await this.buildings.deleteUnit(unitId, this.actor(user));
    return { deleted: true };
  }

  // ─────────────────────────  «تأكيد الشغور»  ─────────────────────────

  /**
   * Records that a unit was found empty, and what says so.
   *
   * Its own route rather than a `PATCH units/:id` carrying two statuses, which
   * is what it used to be: this exempts the owner from the occupancy fee, so it
   * asks for a basis and keeps a record that can be lifted. `updateUnit` now
   * refuses the pair outright and points here.
   *
   * A write, so the field roles — the person who found the flat empty is the
   * person standing at it.
   */
  @Roles(...WRITE_ROLES)
  @Post('units/:unitId/vacancy')
  async confirmVacancy(
    @Param('unitId') unitId: string,
    @Body(new ZodValidationPipe(confirmVacancySchema)) body: ConfirmVacancyInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.confirmVacancy(unitId, body, this.actor(user));
  }

  /**
   * Lifts the vacancy standing on a unit — available at any time.
   *
   * `DELETE` would be the wrong verb twice over: nothing is deleted (the
   * confirmation is closed and kept, like an ended occupancy), and the action
   * takes a body — the reason decides what the unit goes back to.
   */
  @Roles(...WRITE_ROLES)
  @Post('units/:unitId/vacancy/end')
  async endVacancy(
    @Param('unitId') unitId: string,
    @Body(new ZodValidationPipe(endVacancySchema)) body: EndVacancyInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.endVacancy(unitId, body, this.actor(user));
  }

  // ────────────────────────────  Occupancy  ────────────────────────────

  /**
   * Records who is in a unit — and closes whatever case was waiting to find
   * out, which is why the response says how many closed. Silently resolving
   * someone else's case is how a dispatch list stops being believed.
   */
  @Roles(...WRITE_ROLES)
  @Post('occupancies')
  async recordOccupancy(
    @Body(new ZodValidationPipe(upsertOccupancySchema)) body: UpsertOccupancyInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.recordOccupancy(body, this.actor(user));
  }

  /**
   * Ends a spell without deleting it — the history is the point (D2).
   *
   * A مستأجر's or شاغل بتسامح's spell is a tenancy ending, and goes through
   * `TenancyService` — the same operation «إنهاء الإيجار» runs from their file —
   * so their card ends with it, their owner link follows the reason, and the
   * flat is given the status the officer says it has now. An owner's spell keeps
   * its own path.
   */
  @Roles(...WRITE_ROLES)
  @Patch('occupancies/:occupancyId/end')
  async endOccupancy(
    @Param('occupancyId') occupancyId: string,
    @Body(new ZodValidationPipe(endOccupancySchema)) body: EndOccupancyInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.tenancy.endOccupancy(
      occupancyId,
      {
        reason: body.reason,
        endedAt: body.toDate,
        afterStatus: body.afterStatus,
        vacancyBasis: body.vacancyBasis,
        vacancyNotes: body.vacancyNotes,
      },
      this.actor(user),
    );
  }

  // ──────────────────────────────  Visits  ──────────────────────────────

  /**
   * Logs one attempt and moves the unit to what it found.
   *
   * A write, so the field roles — this is the single most common thing an
   * officer does in a stairwell, and routing it through a narrower role would
   * mean the person who knocked cannot record that they knocked.
   */
  @Roles(...WRITE_ROLES)
  @Post('visits')
  async logVisit(
    @Body(new ZodValidationPipe(logVisitSchema)) body: LogVisitInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.buildings.logVisit(body, this.actor(user));
  }

  /** Every attempt on one unit — the panel behind «٣ محاولات». */
  @Roles(...READ_ROLES)
  @Get('units/:unitId/visits')
  async unitVisits(@Param('unitId') unitId: string) {
    return { visits: await this.buildings.visits(unitId) };
  }

  // ──────────────────────────────  Damage  ──────────────────────────────

  /**
   * Appends one observation. There is no update and no delete, deliberately:
   * a building that was unsafe in 2024 and repaired in 2026 is two facts, and
   * the first is what a compensation claim rests on (D3).
   */
  @Roles(...WRITE_ROLES)
  @Post('damage')
  async recordDamage(
    @Body(new ZodValidationPipe(createDamageAssessmentSchema)) body: CreateDamageAssessmentInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.damage.record(body, this.actor(user));
  }
}
