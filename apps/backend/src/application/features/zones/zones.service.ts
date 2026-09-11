import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { CreateZoneInput, UpdateZoneInput } from '@mechanization/shared-schemas';
import { PARCEL_REPOSITORY, ZONE_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import type { ParcelRepository } from '../../../domain/interfaces/parcel-repository.interface';
import type { Zone, ZoneRepository } from '../../../domain/interfaces/zone-repository.interface';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { CadastreAssetsService } from '../../../infrastructure/cadastre/cadastre-assets.service';
import { BuildingsService } from '../buildings/buildings.service';

export interface ZoneSummary {
  id: string;
  name: string;
  code: string;
  color: string;
  description: string | null;
  parcelCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ZoneDetail extends ZoneSummary {
  parcelNumbers: string[];
}

/** How many offending numbers an error message names before it summarises. */
const MAX_NAMED_PARCELS = 5;

@Injectable()
export class ZonesService {
  private readonly logger = new Logger(ZonesService.name);

  /**
   * Dissolved zone outlines, keyed by zone id and the `updatedAt` they were
   * built from. Unioning a zone's member parcels is the expensive part of
   * serving the map layer — hundreds of polygons per zone — and it changes only
   * when the zone is edited, so the timestamp doubles as the invalidation.
   */
  private readonly outlineCache = new Map<
    string,
    { key: string; geometry: Polygon | MultiPolygon | null }
  >();

  constructor(
    @Inject(ZONE_REPOSITORY) private readonly zones: ZoneRepository,
    @Inject(PARCEL_REPOSITORY) private readonly parcels: ParcelRepository,
    private readonly assets: CadastreAssetsService,
    private readonly buildings: BuildingsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Rewrites the building codes a zone edit just invalidated.
   *
   * A building's code is `ZONE-PARCEL-SUFFIX`, and the zone half is resolved
   * from `Zone.parcelNumbers` rather than stored as an FK (D13) — which is what
   * keeps membership in one place, and what makes every stored `code` on these
   * parcels stale the moment the sector changes. Renaming «SEC-A1» to «SEC-A»
   * silently orphans every code printed on a notice under the old one.
   *
   * Called on the union of the parcels *before* and *after* the edit: a parcel
   * moved out of a sector needs its code rebuilt just as much as one moved in,
   * and it is no longer in the list to find it by.
   *
   * Failure is logged, not propagated. The zone edit itself has committed and
   * is correct; a code that has not caught up yet is a display attribute that
   * the next recompute fixes, and throwing here would report a successful save
   * as a failure and invite the admin to make it twice.
   */
  private async refreshBuildingCodes(
    parcelNumbers: readonly string[],
    actor: { id: string; role: string },
  ): Promise<void> {
    try {
      await this.buildings.recomputeCodesForParcels(parcelNumbers, actor);
    } catch (error) {
      this.logger.error(
        `Zone saved, but building codes could not be recomputed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Redrawing a sector decides which inspector is accountable for which
   * parcels, so every write here lands in the audit trail alongside the
   * registration decisions it goes on to shape.
   */
  private recordChange(input: {
    tenantSlug: string;
    action: 'ZONE_CREATED' | 'ZONE_UPDATED' | 'ZONE_DELETED';
    zoneId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actor: { id: string; role: string };
  }): void {
    this.events.emit('zone.changed', {
      tenantSlug: input.tenantSlug,
      action: input.action,
      zoneId: input.zoneId,
      before: input.before,
      after: input.after,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  /** Every sector, with membership reduced to a count. */
  async list(): Promise<ZoneSummary[]> {
    const rows = await this.zones.findAll();
    return rows.map(toSummary);
  }

  /** One sector including the parcel numbers it owns, for the editor. */
  async get(id: string): Promise<ZoneDetail> {
    const zone = await this.zones.findById(id);
    if (!zone) throw new NotFoundError('القطاع غير موجود');
    return { ...toSummary(zone), parcelNumbers: zone.parcelNumbers };
  }

  async create(
    tenantSlug: string,
    input: CreateZoneInput,
    actor: { id: string; role: string },
  ): Promise<ZoneDetail> {
    const existing = await this.zones.findByCode(input.code);
    if (existing) throw new ConflictError(`رمز القطاع "${input.code}" مستخدم بالفعل`);

    await this.validateParcels(tenantSlug, input.parcelNumbers);

    const zone = await this.zones.create({
      name: input.name,
      code: input.code,
      color: input.color,
      description: input.description,
      parcelNumbers: input.parcelNumbers,
    });

    await this.refreshBuildingCodes(zone.parcelNumbers, actor);

    this.recordChange({
      tenantSlug,
      action: 'ZONE_CREATED',
      zoneId: zone.id,
      after: { name: zone.name, code: zone.code, parcelCount: zone.parcelNumbers.length },
      actor,
    });

    return { ...toSummary(zone), parcelNumbers: zone.parcelNumbers };
  }

  async update(
    tenantSlug: string,
    id: string,
    input: UpdateZoneInput,
    actor: { id: string; role: string },
  ): Promise<ZoneDetail> {
    const zone = await this.zones.findById(id);
    if (!zone) throw new NotFoundError('القطاع غير موجود');

    if (input.code && input.code !== zone.code) {
      const clash = await this.zones.findByCode(input.code);
      if (clash) throw new ConflictError(`رمز القطاع "${input.code}" مستخدم بالفعل`);
    }

    if (input.parcelNumbers) {
      await this.validateParcels(tenantSlug, input.parcelNumbers, id);
    }

    const updated = await this.zones.update(id, input);
    this.outlineCache.delete(updated.id);

    // The union of before and after: a parcel moved *out* of this sector needs
    // its codes rebuilt just as much as one moved in, and it is no longer in
    // the new list to be found by.
    await this.refreshBuildingCodes(
      [...new Set([...zone.parcelNumbers, ...updated.parcelNumbers])],
      actor,
    );

    // Membership counts on both sides: "who moved forty parcels out of this
    // sector" is the question this trail gets asked.
    this.recordChange({
      tenantSlug,
      action: 'ZONE_UPDATED',
      zoneId: updated.id,
      before: { name: zone.name, code: zone.code, parcelCount: zone.parcelNumbers.length },
      after: {
        name: updated.name,
        code: updated.code,
        parcelCount: updated.parcelNumbers.length,
      },
      actor,
    });

    return { ...toSummary(updated), parcelNumbers: updated.parcelNumbers };
  }

  async remove(
    tenantSlug: string,
    id: string,
    actor: { id: string; role: string },
  ): Promise<void> {
    const zone = await this.zones.findById(id);
    if (!zone) throw new NotFoundError('القطاع غير موجود');

    // Deleting a zone releases its parcels rather than touching them: membership
    // lives on the zone row, so the parcels are unassigned the moment it is gone.
    await this.zones.delete(id);
    this.outlineCache.delete(id);

    // Its parcels are released, so their buildings fall back to the unzoned
    // `X-…` form until somebody assigns them to a sector again.
    await this.refreshBuildingCodes(zone.parcelNumbers, actor);

    // `before` is the whole record here — after this there is no row left to
    // describe what was deleted.
    this.recordChange({
      tenantSlug,
      action: 'ZONE_DELETED',
      zoneId: id,
      before: {
        name: zone.name,
        code: zone.code,
        parcelCount: zone.parcelNumbers.length,
      },
      actor,
    });
  }

  /**
   * Rejects a selection that a municipality could not actually administer.
   *
   * Three separate failures, reported separately because the fix differs: a
   * number that is not in the cadastre is a typo or a stale client; a number
   * outside the municipality outline is land this council does not govern; a
   * number already in another zone would make "which sector is this parcel in"
   * ambiguous for every report downstream.
   */
  private async validateParcels(
    tenantSlug: string,
    parcelNumbers: readonly string[],
    excludeZoneId?: string,
  ): Promise<void> {
    if (parcelNumbers.length === 0) return;

    // A municipality that has not imported its cadastre accepts any well-formed
    // number, matching how the citizen form treats an empty registry.
    const cadastreSize = await this.parcels.count();
    if (cadastreSize > 0) {
      const known = await this.parcels.findManyByNumber(parcelNumbers);
      const missing = parcelNumbers.filter((n) => !known.has(n));
      if (missing.length > 0) {
        throw new ValidationError(
          `${describe(missing)} غير موجود في السجل العقاري للبلدية`,
        );
      }

      const boundary = await this.assets.getCityBoundary(tenantSlug);
      if (boundary) {
        const outside = parcelNumbers.filter((parcelNumber) => {
          const parcel = known.get(parcelNumber);
          if (!parcel) return false;
          return !turf.booleanPointInPolygon([parcel.longitude, parcel.latitude], boundary);
        });
        if (outside.length > 0) {
          throw new ValidationError(
            `${describe(outside)} يقع خارج نطاق البلدية المعتمد ولا يمكن إضافته للقطاع`,
          );
        }
      }
    }

    const owners = await this.zones.findOwnersOfParcels(parcelNumbers, excludeZoneId);
    if (owners.length > 0) {
      const zoneName = owners[0].zoneName;
      throw new ConflictError(
        `${describe(owners.map((o) => o.parcelNumber))} مضاف بالفعل إلى قطاع "${zoneName}"`,
      );
    }
  }

  /**
   * The zone overlay the maps draw: one feature per zone, its member parcels
   * dissolved into a single shape so the fill reads as one sector rather than
   * as a mosaic of individually-outlined parcels.
   *
   * A zone whose parcels have no traced shape yet still appears, carrying null
   * geometry — the map skips drawing it but the legend can still list it, which
   * is better than a sector silently vanishing from the UI.
   */
  async buildGeoJson(tenantSlug: string): Promise<{
    type: 'FeatureCollection';
    features: Feature[];
  }> {
    const zones = await this.zones.findAll();
    const shapes = await this.assets.getParcelPolygons(tenantSlug);

    const features: Feature[] = [];
    for (const zone of zones) {
      const geometry = this.dissolve(zone, shapes);
      if (!geometry) continue;

      features.push({
        type: 'Feature',
        properties: {
          zoneId: zone.id,
          name: zone.name,
          code: zone.code,
          color: zone.color,
          parcelCount: zone.parcelNumbers.length,
        },
        geometry,
      });
    }

    return { type: 'FeatureCollection', features };
  }

  private dissolve(
    zone: Zone,
    shapes: Map<string, Feature<Polygon>>,
  ): Polygon | MultiPolygon | null {
    const cacheKey = `${zone.updatedAt.getTime()}:${zone.parcelNumbers.length}`;
    const hit = this.outlineCache.get(zone.id);
    if (hit && hit.key === cacheKey) return hit.geometry;

    const members = zone.parcelNumbers
      .map((parcelNumber) => shapes.get(parcelNumber))
      .filter((f): f is Feature<Polygon> => Boolean(f));

    let geometry: Polygon | MultiPolygon | null = null;
    if (members.length === 1) {
      geometry = members[0].geometry;
    } else if (members.length > 1) {
      // Pairwise rather than a single n-way union: turf unions two features at a
      // time, and halving the set each round keeps a 500-parcel sector at ~9
      // rounds instead of 500 sequential merges over a steadily larger polygon.
      let round: Feature<Polygon | MultiPolygon>[] = members;
      while (round.length > 1) {
        const next: Feature<Polygon | MultiPolygon>[] = [];
        let mergedAny = false;

        for (let i = 0; i < round.length; i += 2) {
          if (i + 1 >= round.length) {
            next.push(round[i]);
            continue;
          }
          const merged = turf.union(turf.featureCollection([round[i], round[i + 1]] as never));
          if (merged) {
            next.push(merged as Feature<Polygon | MultiPolygon>);
            mergedAny = true;
          } else {
            // Two parcels that do not touch cannot merge directly
            next.push(round[i], round[i + 1]);
          }
        }

        // If no merges happened during this round, the remaining features are
        // disjoint clusters. Collect their polygon coordinates into a MultiPolygon.
        if (!mergedAny || next.length === round.length) {
          const coordinates: Polygon['coordinates'][] = [];
          for (const feat of next) {
            if (feat.geometry.type === 'Polygon') {
              coordinates.push(feat.geometry.coordinates);
            } else if (feat.geometry.type === 'MultiPolygon') {
              coordinates.push(...feat.geometry.coordinates);
            }
          }
          geometry = {
            type: 'MultiPolygon',
            coordinates,
          };
          break;
        }

        round = next;
      }

      if (!geometry && round[0]) {
        geometry = round[0].geometry;
      }
    }

    this.outlineCache.set(zone.id, { key: cacheKey, geometry });
    return geometry;
  }
}

/** Drops a sector's parcel list down to the count the list view shows. */
function toSummary(zone: Zone): ZoneSummary {
  return {
    id: zone.id,
    name: zone.name,
    code: zone.code,
    color: zone.color,
    description: zone.description,
    parcelCount: zone.parcelNumbers.length,
    createdAt: zone.createdAt,
    updatedAt: zone.updatedAt,
  };
}

/** "العقار رقم 12" / "العقارات 12، 15 و3 أخرى" — a list a clerk can act on. */
function describe(parcelNumbers: readonly string[]): string {
  if (parcelNumbers.length === 1) return `العقار رقم ${parcelNumbers[0]}`;

  const named = parcelNumbers.slice(0, MAX_NAMED_PARCELS).join('، ');
  const rest = parcelNumbers.length - MAX_NAMED_PARCELS;
  return rest > 0 ? `العقارات ${named} و${rest} أخرى` : `العقارات ${named}`;
}
