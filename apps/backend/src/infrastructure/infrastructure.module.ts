import { Global, Module } from '@nestjs/common';
import {
  AUDIT_REPOSITORY,
  CADASTRE_STORAGE_SERVICE,
  EMAIL_SENDER,
  CASE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  IMAGE_STORAGE_SERVICE,
  OTP_REPOSITORY,
  PARCEL_REPOSITORY,
  PASSWORD_HASHER,
  REGISTRATION_REPOSITORY,
  SMS_SENDER,
  TENANT_REPOSITORY,
  TOTP_SERVICE,
  USER_REPOSITORY,
  ZONE_REPOSITORY,
} from '../domain/interfaces/base-repository.interface';
import { WHISH_GATEWAY } from '../domain/interfaces/whish-gateway.interface';
import { WhishGatewayService } from './payments/whish-gateway.service';
import { S3CadastreStorageService } from './aws/s3-cadastre-storage.service';
import { SmtpEmailSender } from './email/smtp-email.sender';
import { S3StorageService } from './aws/s3-storage.service';
import { RedisCacheService } from './cache/redis-cache.service';
import { CadastreAssetsService } from './cadastre/cadastre-assets.service';
import { TenantContextService } from './context/tenant-context.service';
import { RegistryPrismaService } from './prisma/registry-prisma.service';
import { TenantPrismaFactory } from './prisma/tenant-prisma.factory';
import { PrismaAuditRepository } from './repositories/audit.repository';
import { PrismaCaseRepository } from './repositories/case.repository';
import { PrismaDocumentRepository } from './repositories/document.repository';
import { PrismaOtpRepository } from './repositories/otp.repository';
import { PrismaParcelRepository } from './repositories/parcel.repository';
import { PrismaRegistrationRepository } from './repositories/registration.repository';
import { PrismaTenantRepository } from './repositories/tenant.repository';
import { PrismaUserRepository } from './repositories/user.repository';
import { PrismaZoneRepository } from './repositories/zone.repository';
import { BcryptPasswordHasher } from './security/bcrypt-password.hasher';
import { OtplibTotpService } from './security/totp.service';
import { SmsProviderService } from './sms/sms-provider.service';

/**
 * Binds every domain port to its concrete adapter. This is the only module that
 * knows Prisma, Supabase or bcrypt exist — the application layer sees symbols.
 *
 * Global because the tenant context and Prisma clients are genuinely
 * cross-cutting: every feature module would otherwise re-import the same set.
 */
@Global()
@Module({
  providers: [
    TenantContextService,
    RegistryPrismaService,
    TenantPrismaFactory,
    RedisCacheService,
    CadastreAssetsService,

    { provide: TENANT_REPOSITORY, useClass: PrismaTenantRepository },
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: REGISTRATION_REPOSITORY, useClass: PrismaRegistrationRepository },
    { provide: PARCEL_REPOSITORY, useClass: PrismaParcelRepository },
    { provide: DOCUMENT_REPOSITORY, useClass: PrismaDocumentRepository },
    { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
    { provide: OTP_REPOSITORY, useClass: PrismaOtpRepository },
    { provide: ZONE_REPOSITORY, useClass: PrismaZoneRepository },
    { provide: CASE_REPOSITORY, useClass: PrismaCaseRepository },

    // Both object stores are S3, and S3 only. The Supabase adapters are still
    // on disk but nothing binds them any more, deliberately: a fallback that
    // answered whenever the S3 config was wrong would split a municipality's
    // documents across two stores, and the `storagePath` already recorded on
    // every document row would point at whichever store happened to be live
    // the day it was written. One binding means a misconfiguration is a boot
    // failure — loud, and fixable in a minute — instead of a slow divergence
    // nobody notices until a scan cannot be found.
    { provide: IMAGE_STORAGE_SERVICE, useClass: S3StorageService },
    { provide: CADASTRE_STORAGE_SERVICE, useClass: S3CadastreStorageService },
    { provide: EMAIL_SENDER, useClass: SmtpEmailSender },
    { provide: SMS_SENDER, useClass: SmsProviderService },
    { provide: WHISH_GATEWAY, useClass: WhishGatewayService },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOTP_SERVICE, useClass: OtplibTotpService },
  ],
  exports: [
    TenantContextService,
    RegistryPrismaService,
    TenantPrismaFactory,
    RedisCacheService,
    CadastreAssetsService,
    TENANT_REPOSITORY,
    USER_REPOSITORY,
    REGISTRATION_REPOSITORY,
    PARCEL_REPOSITORY,
    DOCUMENT_REPOSITORY,
    AUDIT_REPOSITORY,
    OTP_REPOSITORY,
    ZONE_REPOSITORY,
    CASE_REPOSITORY,
    IMAGE_STORAGE_SERVICE,
    CADASTRE_STORAGE_SERVICE,
    EMAIL_SENDER,
    SMS_SENDER,
    WHISH_GATEWAY,
    PASSWORD_HASHER,
    TOTP_SERVICE,
  ],
})
export class InfrastructureModule {}
