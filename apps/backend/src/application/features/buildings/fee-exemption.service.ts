import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isStructuralUnitType, type SetUnitFeeExemptionInput } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService, type BuildingChange } from '../audit/audit.service';

/** The audit actions, and the names «فواتير تأثّرت بتصحيحات» traces them by. */
export const UNIT_FEE_EXEMPTION_SET = 'UNIT_FEE_EXEMPTION_SET';
export const UNIT_FEE_EXEMPTION_LIFTED = 'UNIT_FEE_EXEMPTION_LIFTED';

/** A unit's exemption as the drawer shows it. */
export interface UnitFeeExemptionState {
  unitId: string;
  unitCode: string;
  feeExemption: 'PLACE_OF_WORSHIP' | 'PUBLIC_FACILITY' | 'OTHER' | null;
  feeExemptionNote: string | null;
  feeExemptedAt: Date | null;
  feeExemptedById: string | null;
}

/**
 * «معفاة من الرسوم» — granting or lifting a unit's exemption from every fee
 * (migration 0077; the user's decision, 2026-10-07: the mosque on a waqf parcel
 * is exempt, a shop the waqf rents out is billed to its tenant as usual).
 *
 * SUPER_ADMIN only (the route says so): it takes a unit off every bill, for
 * every person who holds it. Tier 1 — the audit row is written inside the
 * transaction, and it names every person on the unit so «فواتير تأثّرت
 * بتصحيحات» reaches each one's bill.
 */
@Injectable()
export class FeeExemptionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditTrail: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async set(
    unitId: string,
    input: SetUnitFeeExemptionInput,
    actor: { id: string; role: string },
  ): Promise<UnitFeeExemptionState> {
    const change = await runInTenantTransaction(this.tenantContext, async () => {
      await this.db.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      await this.db.$queryRaw`SELECT "id" FROM ${this.S}"units" WHERE "id" = ${unitId}::uuid FOR UPDATE`;

      const unit = await this.db.unit.findUnique({
        where: { id: unitId },
        select: {
          id: true,
          buildingId: true,
          unitCode: true,
          unitType: true,
          feeExemption: true,
          feeExemptionNote: true,
          feeExemptedAt: true,
          feeExemptedById: true,
          occupancies: { where: { toDate: null }, select: { citizenId: true } },
        },
      });
      if (!unit) throw new NotFoundError({ code: 'UNIT_NOT_FOUND', message: 'This unit could not be found.' });

      // A structural floor is never billed: there is nothing to exempt it from.
      if (input.reason !== null && isStructuralUnitType(unit.unitType)) {
        throw new ValidationError({
          code: 'FEE_EXEMPTION_STRUCTURAL_UNIT',
          message: 'A structural floor is never billed, so it cannot be exempted.',
          params: { unitCode: unit.unitCode },
        });
      }

      const note = input.reason === null ? null : input.note?.trim() || null;
      const unchanged =
        unit.feeExemption === input.reason && (input.reason === null || unit.feeExemptionNote === note);
      if (unchanged) return { unit: toState(unit), audited: null };

      const at = new Date();
      const updated = await this.db.unit.update({
        where: { id: unit.id },
        data:
          input.reason === null
            ? { feeExemption: null, feeExemptionNote: null, feeExemptedById: null, feeExemptedAt: null }
            : { feeExemption: input.reason, feeExemptionNote: note, feeExemptedById: actor.id, feeExemptedAt: at },
        select: {
          id: true,
          unitCode: true,
          feeExemption: true,
          feeExemptionNote: true,
          feeExemptedAt: true,
          feeExemptedById: true,
        },
      });

      const payload: BuildingChange & { tenantSlug: string } = {
        tenantSlug: this.tenantContext.tenantSlug,
        action: input.reason === null ? UNIT_FEE_EXEMPTION_LIFTED : UNIT_FEE_EXEMPTION_SET,
        buildingId: unit.buildingId,
        before: {
          unitId: unit.id,
          unitCode: unit.unitCode,
          feeExemption: unit.feeExemption,
          ...(unit.feeExemptionNote ? { note: unit.feeExemptionNote } : {}),
        },
        after: {
          unitId: unit.id,
          unitCode: unit.unitCode,
          feeExemption: input.reason,
          ...(note ? { note } : {}),
          // Everyone on the unit now, so «فواتير تأثّرت بتصحيحات» reaches each one's bill.
          citizens: [...new Set(unit.occupancies.map((spell) => spell.citizenId))],
        },
        actorId: actor.id,
        actorRole: actor.role,
      };
      await this.auditTrail.recordChangeInTransaction({ channel: 'building.changed', payload });
      return { unit: toState(updated), audited: payload };
    });

    if (change.audited) this.events.emit('building.changed', { ...change.audited, alreadyAudited: true });
    return change.unit;
  }
}

function toState(unit: {
  id: string;
  unitCode: string;
  feeExemption: UnitFeeExemptionState['feeExemption'];
  feeExemptionNote: string | null;
  feeExemptedAt: Date | null;
  feeExemptedById: string | null;
}): UnitFeeExemptionState {
  return {
    unitId: unit.id,
    unitCode: unit.unitCode,
    feeExemption: unit.feeExemption,
    feeExemptionNote: unit.feeExemptionNote,
    feeExemptedAt: unit.feeExemptedAt,
    feeExemptedById: unit.feeExemptedById,
  };
}
