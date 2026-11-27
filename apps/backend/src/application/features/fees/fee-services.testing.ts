import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import type { TenantContextService, TenantScope } from '../../../infrastructure/context/tenant-context.service';
import { inTenantScope } from '../../../infrastructure/context/in-tenant-scope.testing';
import type { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import type { AuditService } from '../audit/audit.service';
import { BillLifecycleService } from './bill-lifecycle.service';
import { FeeNoticesService } from './fee-notices.service';
import { FeesService } from './fees.service';
import type { PaymentLedgerService } from './payment-ledger.service';
import { RecurringBillingService } from './recurring-billing.service';
import { WhishCheckoutService } from './whish-checkout.service';

export interface FeeServices {
  fees: FeesService;
  feeNotices: FeeNoticesService;
  recurringBilling: RecurringBillingService;
  billLifecycle: BillLifecycleService;
  whishCheckout: WhishCheckoutService;
}

/**
 * For specs: the fee services wired to each other as `ApplicationModule` wires
 * them, from the six things `FeesService` took before audit GOD-01 to GOD-04
 * split it (in that order), so a spec's stand-ins are built once and shared.
 */
export function feeServices(
  context: TenantContextService,
  events: EventEmitter2,
  whish: WhishGateway,
  cache: RedisCacheService,
  ledger: PaymentLedgerService,
  audit: AuditService,
): FeeServices {
  const fees = new FeesService(context, events, cache, ledger, audit);
  const feeNotices = new FeeNoticesService(context, events, ledger, audit, fees);
  return {
    fees,
    feeNotices,
    recurringBilling: new RecurringBillingService(context, events, fees, feeNotices),
    billLifecycle: new BillLifecycleService(context, events, ledger, audit, fees),
    whishCheckout: new WhishCheckoutService(context, events, whish, ledger, audit),
  };
}

/** `inTenantScope` over each of them: every call made from the spec runs inside `scope`. */
export function feeServicesInTenantScope(services: FeeServices, context: TenantContextService, scope: TenantScope): FeeServices {
  return {
    fees: inTenantScope(services.fees, context, scope),
    feeNotices: inTenantScope(services.feeNotices, context, scope),
    recurringBilling: inTenantScope(services.recurringBilling, context, scope),
    billLifecycle: inTenantScope(services.billLifecycle, context, scope),
    whishCheckout: inTenantScope(services.whishCheckout, context, scope),
  };
}
