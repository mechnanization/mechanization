import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ApplicationModule } from '../application/application.module';
import { AuditController } from './controllers/audit.controller';
import { BackupController } from './controllers/backup.controller';
import { AuthController } from './controllers/auth.controller';
import { CadastreController } from './controllers/cadastre.controller';
import { BuildingsController } from './controllers/buildings.controller';
import { CasesController } from './controllers/cases.controller';
import { CitizenController } from './controllers/citizen.controller';
import { DashboardController } from './controllers/dashboard.controller';
import { DocumentController } from './controllers/document.controller';
import { HealthController } from './controllers/health.controller';
import { InternalCronController } from './controllers/internal-cron.controller';
import { RegistrationController } from './controllers/registration.controller';
import { TenantController } from './controllers/tenant.controller';
import { FeesController } from './controllers/fees.controller';
import { StaffController } from './controllers/staff.controller';
import { ZonesController } from './controllers/zones.controller';
import { QualityController } from './controllers/quality.controller';
import { DomainExceptionFilter } from './filters/domain-exception.filter';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { TenantMiddleware } from './middleware/tenant.middleware';

@Module({
  imports: [ApplicationModule],
  controllers: [
    HealthController,
    InternalCronController,
    TenantController,
    AuthController,
    RegistrationController,
    DocumentController,
    AuditController,
    DashboardController,
    CitizenController,
    CadastreController,
    FeesController,
    StaffController,
    ZonesController,
    CasesController,
    QualityController,
    BuildingsController,
    BackupController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    /**
     * Rate limit, then authenticate, then authorise — in that order, because
     * guards run in the order they are registered and a flood should be turned
     * away before it costs a token verification or a database round trip.
     *
     * `ThrottlerGuard` had never been registered at all. `ThrottlerModule.forRoot`
     * in AppModule configured it and the `@Throttle` decorators on the login
     * routes set their metadata, but with nothing reading that metadata every
     * limit in this codebase was decorative: staff login, the OTP request that
     * costs the municipality money per SMS, and the رقم مرجعي sign-in could each
     * be called without bound. Verified by calling one of them past its limit
     * and getting six successes out of six.
     *
     * Opting out of auth is explicit (`@Public()`), so a new controller is
     * protected by default — the failure mode of forgetting is a locked door,
     * not an open one.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class PresentationModule implements NestModule {
  /**
   * Binds `TenantMiddleware` to every tenant-scoped path, which is what
   * gives the request its municipality-specific Prisma client.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });

    /**
     * Tenant resolution runs only under `/t/:tenantSlug`. Health checks sit
     * outside it deliberately: they must answer even when the registry is down.
     *
     * The wildcard is Express 4 syntax (`*`, not `*path`): under
     * path-to-regexp 0.1.x a named wildcard is read as `(.*)` followed by the
     * literal text, so `*path` silently matches nothing and every route below
     * runs with no tenant scope at all.
     */
    consumer
      .apply(TenantMiddleware)
      .forRoutes({ path: 't/:tenantSlug/*', method: RequestMethod.ALL });
  }
}
