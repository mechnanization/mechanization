import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { OtpCleanupJob } from './background-jobs/otp-cleanup.job';
import { RecurringBillingJob } from './background-jobs/recurring-billing.job';
import { AuditService } from './features/audit/audit.service';
import { BackupService } from './features/backup/backup.service';
import { CadastreImportService } from './features/cadastre/cadastre-import.service';
import { BuildingsService } from './features/buildings/buildings.service';
import { CensusSyncService } from './features/buildings/census-sync.service';
import { DamageService } from './features/buildings/damage.service';
import { CasesService } from './features/cases/cases.service';
import { CitizensService } from './features/citizens/citizens.service';
import { LandlordLinkService } from './features/citizens/landlord-link.service';
import { TenancyService } from './features/citizens/tenancy.service';
import { DocumentService } from './features/documents/document.service';
import { IdentityService } from './features/identity/identity.service';
import { OtpService } from './features/identity/otp.service';
import { SessionRevocationService } from './features/identity/session-revocation.service';
import { RegistrationService } from './features/registration/registration.service';
import { ReportingService } from './features/reporting/reporting.service';
import { TenantService } from './features/tenant/tenant.service';
import { FeesService } from './features/fees/fees.service';
import { PaymentLedgerService } from './features/fees/payment-ledger.service';
import { StaffService } from './features/staff/staff.service';
import { ZonesService } from './features/zones/zones.service';
import { DataQualityService } from './features/quality/data-quality.service';
import { RecordReviewService } from './features/quality/record-review.service';

/**
 * One service per bounded context — no command/query handler registration, no
 * `CqrsModule`. Adding a use-case is adding a method, not adding two classes and
 * a handler binding.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // One signing key for citizen and staff tokens alike — the unification
        // in Section 10 is what makes a single JwtAuthGuard correct.
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [
    TenantService,
    IdentityService,
    OtpService,
    SessionRevocationService,
    RegistrationService,
    DocumentService,
    AuditService,
    ReportingService,
    CadastreImportService,
    CitizensService,
    LandlordLinkService,
    TenancyService,
    FeesService,
    PaymentLedgerService,
    StaffService,
    ZonesService,
    CasesService,
    BuildingsService,
    CensusSyncService,
    DamageService,
    BackupService,
    RecordReviewService,
    DataQualityService,
    OtpCleanupJob,
    RecurringBillingJob,
  ],
  exports: [
    TenantService,
    IdentityService,
    OtpService,
    SessionRevocationService,
    RegistrationService,
    DocumentService,
    AuditService,
    ReportingService,
    CadastreImportService,
    CitizensService,
    LandlordLinkService,
    TenancyService,
    FeesService,
    PaymentLedgerService,
    StaffService,
    ZonesService,
    CasesService,
    BuildingsService,
    CensusSyncService,
    DamageService,
    BackupService,
    RecordReviewService,
    DataQualityService,
    OtpCleanupJob,
    RecurringBillingJob,
    JwtModule,
  ],
})
export class ApplicationModule {}
