import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  isStructuralUnitType,
  type OwnerBillingRule,
  type OwnerBillingState,
  type SetOwnerBillingInput,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { billableUnits } from '../../../domain/entities/billable-unit';
import { NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService, type BuildingChange } from '../audit/audit.service';
import { FeesService } from '../fees/fees.service';
import { describeOwnerBilling, planOwnerBilling, type OwnerBillingRefusal } from './owner-billing.plan';
import { activeOwnerSpells } from './owner-billing';

/** The audit action, and the name «فواتير تأثّرت بتصحيحات» traces it by. */
export const UNIT_OWNER_BILLING_SET = 'UNIT_OWNER_BILLING_SET';

type Actor = { id: string; role: string };

/** The English line each refusal logs; the screen's words come from the code. */
const REFUSAL_MESSAGES: Record<OwnerBillingRefusal['code'], string> = {
  OWNER_BILLING_STRUCTURAL_UNIT: 'A structural floor has no owners to divide a fee between.',
  OWNER_BILLING_NOT_CO_OWNED: 'A billing method can only be chosen for a unit with two or more current owners.',
  OWNER_BILLING_SHARES_NOT_OWNER: 'Shares can only be recorded for a current owner of this unit.',
  OWNER_BILLING_RESPONSIBLE_NOT_OWNER: 'The responsible owner must be a current owner of this unit.',
  OWNER_BILLING_SHARES_MISSING: 'Billing by shares needs every current owner’s shares recorded.',
};

/**
 * «توزيع الرسم على المالكين» — the officer's choice of how a flat with several
 * owners is billed (migration 0075; the user's decision, 2026-10-07).
 *
 * The rule itself is `ownerShareOf` in the shared package; billing applies it
 * (`FeesService.holdingsOf`). This saves the choice, under a lock on the unit,
 * refusing any choice billing could not carry out, and records it in the
 * audit trail inside the same transaction: it moves co-owners' bills, so it is
 * a Tier 1 change (docs/security.md).
 */
@Injectable()
export class OwnerBillingService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly fees: FeesService,
    private readonly auditTrail: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async set(unitId: string, input: SetOwnerBillingInput, actor: Actor): Promise<OwnerBillingState> {
    const change = await runInTenantTransaction(this.tenantContext, async () => {
      await this.db.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      await this.db.$queryRaw`SELECT "id" FROM ${this.S}"units" WHERE "id" = ${unitId}::uuid FOR UPDATE`;

      const unit = await this.load(unitId);
      const planned = planOwnerBilling(
        {
          unitCode: unit.unitCode,
          structural: isStructuralUnitType(unit.unitType),
          mode: unit.ownerBillingMode,
          responsibleOwnerId: unit.responsibleOwnerId,
          spells: unit.occupancies,
        },
        input,
      );
      if (!planned.ok) {
        throw new ValidationError({
          code: planned.refusal.code,
          message: REFUSAL_MESSAGES[planned.refusal.code],
          params: planned.refusal.params,
        });
      }
      const { write } = planned;

      /*
        The responsible owner has to be someone billing will actually charge
        for this flat — their newest file must claim it as its owner. Naming an
        owner recorded only on the matrix would exempt the others and bill
        nobody. Asked through `holdingsOf`, the read every billing run makes,
        so this check cannot disagree with the bill.
      */
      if (write.responsibleOwnerId) await this.assertBilledHere(unit.id, unit.unitCode, write.responsibleOwnerId);

      if (!write.changed) return { unit, write, audited: null };

      for (const entry of write.shareWrites) {
        await this.db.unitOccupancy.update({ where: { id: entry.spellId }, data: { shares: entry.shares } });
      }
      await this.db.unit.update({
        where: { id: unit.id },
        data: { ownerBillingMode: write.mode, responsibleOwnerId: write.responsibleOwnerId },
      });

      const payload: BuildingChange & { tenantSlug: string } = {
        tenantSlug: this.tenantContext.tenantSlug,
        action: UNIT_OWNER_BILLING_SET,
        buildingId: unit.buildingId,
        before: {
          unitId: unit.id,
          unitCode: unit.unitCode,
          ownerBillingMode: unit.ownerBillingMode,
          responsibleOwnerId: unit.responsibleOwnerId,
          shares: unit.occupancies.map((spell) => ({ citizenId: spell.citizenId, shares: spell.shares })),
        },
        after: {
          unitId: unit.id,
          unitCode: unit.unitCode,
          ownerBillingMode: write.mode,
          responsibleOwnerId: write.responsibleOwnerId,
          shares: write.rule.owners,
          // Every co-owner, so «فواتير تأثّرت بتصحيحات» reaches each one's bill.
          citizens: [...new Set(unit.occupancies.map((spell) => spell.citizenId))],
        },
        actorId: actor.id,
        actorRole: actor.role,
      };
      await this.auditTrail.recordChangeInTransaction({ channel: 'building.changed', payload });
      return { unit, write, audited: payload };
    });

    // After the commit: the caches hear it; the row is already written.
    if (change.audited) this.events.emit('building.changed', { ...change.audited, alreadyAudited: true });

    return toState(change.unit.id, change.unit.unitCode, change.write.rule);
  }

  private async load(unitId: string) {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: {
        id: true,
        buildingId: true,
        unitCode: true,
        unitType: true,
        ownerBillingMode: true,
        responsibleOwnerId: true,
        // Owners with an open file only: an archived owner is never billed (see `ownerBillingRules`).
        occupancies: activeOwnerSpells({ id: true, citizenId: true, shares: true }),
      },
    });
    if (!unit) {
      throw new NotFoundError({ code: 'UNIT_NOT_FOUND', message: 'This unit could not be found.' });
    }
    return unit;
  }

  private async assertBilledHere(unitId: string, unitCode: string, citizenId: string): Promise<void> {
    for await (const batch of this.fees.holdingsOf([citizenId])) {
      for (const holding of batch) {
        const billed = holding.entries
          .flatMap(billableUnits)
          .some((unit) => unit.unitId === unitId && unit.occupancyType === 'OWNER');
        if (billed) return;
      }
    }
    throw new ValidationError({
      code: 'OWNER_BILLING_RESPONSIBLE_NOT_BILLED',
      message: 'The responsible owner’s own file does not claim this unit, so billing could not charge them for it.',
      params: { unitCode },
    });
  }
}

function toState(unitId: string, unitCode: string, rule: OwnerBillingRule): OwnerBillingState {
  const described = describeOwnerBilling(rule);
  return {
    unitId,
    unitCode,
    mode: rule.mode,
    responsibleOwnerId: rule.responsibleOwnerId,
    effectiveMode: described.effective.mode,
    fallback: described.effective.fallback,
    owners: described.owners.map((owner) => ({
      citizenId: owner.citizenId,
      shares: owner.shares,
      share:
        owner.outcome.kind === 'SHARE'
          ? { numerator: owner.outcome.share.numerator, denominator: owner.outcome.share.denominator }
          : owner.outcome.kind === 'WHOLE'
            ? { numerator: 1, denominator: 1 }
            : null,
    })),
  };
}
