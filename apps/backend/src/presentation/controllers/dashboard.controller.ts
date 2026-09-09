import { Controller, Get, Header, Param } from '@nestjs/common';
import { BuildingsService } from '../../application/features/buildings/buildings.service';
import { ReportingService } from '../../application/features/reporting/reporting.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * The register's overview, and only for the roles accountable for the register.
 *
 * Every figure below counts registrations, properties and their locations —
 * none of it is financial. So COLLECTOR, ACCOUNTANT and ADMINISTRATIVE_OFFICER
 * are deliberately absent rather than accidentally omitted: the accountant's
 * numbers are `fees/summary` and the collector's work is a citizen at a time,
 * and neither job is improved by a municipality-wide view of who is on the
 * register. A role that cannot act on a total does not need to be shown it.
 */
@Controller('t/:tenantSlug/dashboard')
export class DashboardController {
  constructor(
    private readonly reporting: ReportingService,
    private readonly buildings: BuildingsService,
  ) {}

  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR')
  @Get('counters')
  async counters() {
    return this.reporting.getDashboardCounters();
  }

  /**
   * Everything the analytics dashboard plots, in one payload.
   *
   * Deliberately one endpoint rather than one per widget: the KPI tiles and
   * the charts have to agree, and separately-cached fetches guarantee a window
   * where a rate computed from one response contradicts a total from another.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR')
  @Get('analytics')
  async analytics() {
    return this.reporting.getAnalytics();
  }

  /** Marker coordinates for the MapLibre panel. */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Get('map')
  async spatial() {
    return { features: await this.reporting.getSpatialData() };
  }

  /**
   * Every building pin, with the three channels the map styles off: what kind
   * of structure it is, how far its survey has got, and what condition it is in.
   *
   * `surveyRollup` is the **worst** status among its units, never the majority
   * (D11) — a block of twelve flats with one nobody answered is not a surveyed
   * building, and colouring it complete hides the one fact the map was drawn to
   * show.
   *
   * Not cached, unlike the counters and analytics beside it. This is the screen
   * a field officer refreshes after recording an occupancy, and a five-minute
   * TTL there reads as "the survey did not save".
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Get('map/buildings')
  @Header('Cache-Control', 'no-store')
  async buildingPins() {
    return { buildings: await this.buildings.mapPins() };
  }

  /**
   * Parcels that actually have citizen registrations, each with everyone
   * attached to it.
   *
   * The fullscreen map draws the whole cadastre from a static GeoJSON and
   * places an interactive marker only on what this returns — so a dot always
   * means there is a citizen record behind it.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Get('map/parcels')
  async registeredParcels() {
    return { parcels: await this.reporting.getRegisteredParcels() };
  }

  /**
   * Bulk export, restricted to SUPER_ADMIN and AUDITOR: this is the one action
   * that moves every citizen's details out of the audited system and onto
   * someone's laptop. The export itself is recorded with its row count.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR')
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="registrations.csv"')
  async exportCsv(
    @Param('tenantSlug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
  ) {
    // The `status` filter is gone with the review workflow — there is one
    // export now, of everything on file.
    const csv = await this.reporting.exportCsv({
      tenantSlug,
      actor: { id: user.sub, role: user.role ?? '' },
    });

    // BOM so Excel opens Arabic names as UTF-8 rather than mojibake — without
    // it every export looks corrupted to the staff who requested it.
    return `﻿${csv}`;
  }
}
