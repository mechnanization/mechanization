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
  STAFF_REFRESH_TOKEN_REPOSITORY,
  TENANT_REPOSITORY,
  TOTP_SERVICE,
  USER_REPOSITORY,
  ZONE_REPOSITORY,
} from '../domain/interfaces/base-repository.interface';
import { DAY3ATI_INTEGRATION } from '../domain/interfaces/day3ati-integration.interface';
import { DAY3ATI_NEWS, DAY3ATI_VILLAGES } from '../domain/interfaces/day3ati-news.interface';
import { DAY3ATI_TOKENS } from '../domain/interfaces/day3ati-tokens.interface';
import { WHISH_GATEWAY } from '../domain/interfaces/whish-gateway.interface';
import { Day3atiIntegrationClient } from './day3ati/day3ati-integration.client';
import { Day3atiNewsClient } from './day3ati/day3ati-news.client';
import { Day3atiTokenService } from './day3ati/day3ati-token.service';
import { Day3atiVillageDirectory } from './day3ati/day3ati-village-directory';
import { WhishGatewayService } from './payments/whish-gateway.service';
import { S3CadastreStorageService } from './aws/s3-cadastre-storage.service';
import { S3RequestFileStorageService } from './aws/s3-request-file-storage.service';
import { REQUEST_FILE_STORAGE } from '../domain/interfaces/request-file-storage.interface';
import { SmtpEmailSender } from './email/smtp-email.sender';
import { S3StorageService } from './aws/s3-storage.service';
import { RedisCacheService } from './cache/redis-cache.service';
import { RedisThrottlerStorage } from './cache/redis-throttler-storage';
import { TenantContextService } from './context/tenant-context.service';
import { TenantRunner } from './context/tenant-runner';
import { RegistryPrismaService } from './prisma/registry-prisma.service';
import { TenantPrismaFactory } from './prisma/tenant-prisma.factory';
import { PrismaAuditRepository } from './repositories/audit.repository';
import { PrismaCaseRepository } from './repositories/case.repository';
import { PrismaDocumentRepository } from './repositories/document.repository';
import { PrismaOtpRepository } from './repositories/otp.repository';
import { PrismaParcelRepository } from './repositories/parcel.repository';
import { PrismaRegistrationRepository } from './repositories/registration.repository';
import { PrismaStaffRefreshTokenRepository } from './repositories/staff-refresh-token.repository';
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
    TenantRunner,
    RegistryPrismaService,
    TenantPrismaFactory,
    RedisCacheService,
    RedisThrottlerStorage,

    { provide: TENANT_REPOSITORY, useClass: PrismaTenantRepository },
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: REGISTRATION_REPOSITORY, useClass: PrismaRegistrationRepository },
    { provide: PARCEL_REPOSITORY, useClass: PrismaParcelRepository },
    { provide: DOCUMENT_REPOSITORY, useClass: PrismaDocumentRepository },
    { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
    { provide: OTP_REPOSITORY, useClass: PrismaOtpRepository },
    { provide: STAFF_REFRESH_TOKEN_REPOSITORY, useClass: PrismaStaffRefreshTokenRepository },
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
    // The papers on a municipal request: the same private bucket, keys of their own (0092).
    { provide: REQUEST_FILE_STORAGE, useClass: S3RequestFileStorageService },
    { provide: EMAIL_SENDER, useClass: SmtpEmailSender },
    { provide: SMS_SENDER, useClass: SmsProviderService },
    { provide: WHISH_GATEWAY, useClass: WhishGatewayService },
    // Day3ati's tokens, for the News partner API. Off, and harmless, until the four DAY3ATI_* settings are set.
    { provide: DAY3ATI_TOKENS, useClass: Day3atiTokenService },
    // Day3ati's staff accounts (/api/v1/integration), called with the client token. Same switch.
    { provide: DAY3ATI_INTEGRATION, useClass: Day3atiIntegrationClient },
    // Where each municipality's News lives, and the one client every News screen calls Day3ati through.
    { provide: DAY3ATI_VILLAGES, useClass: Day3atiVillageDirectory },
    { provide: DAY3ATI_NEWS, useClass: Day3atiNewsClient },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOTP_SERVICE, useClass: OtplibTotpService },
  ],
  exports: [
    TenantContextService,
    TenantRunner,
    RegistryPrismaService,
    TenantPrismaFactory,
    RedisCacheService,
    RedisThrottlerStorage,
    TENANT_REPOSITORY,
    USER_REPOSITORY,
    REGISTRATION_REPOSITORY,
    PARCEL_REPOSITORY,
    DOCUMENT_REPOSITORY,
    AUDIT_REPOSITORY,
    OTP_REPOSITORY,
    STAFF_REFRESH_TOKEN_REPOSITORY,
    ZONE_REPOSITORY,
    CASE_REPOSITORY,
    IMAGE_STORAGE_SERVICE,
    CADASTRE_STORAGE_SERVICE,
    REQUEST_FILE_STORAGE,
    EMAIL_SENDER,
    SMS_SENDER,
    WHISH_GATEWAY,
    DAY3ATI_TOKENS,
    DAY3ATI_INTEGRATION,
    DAY3ATI_VILLAGES,
    DAY3ATI_NEWS,
    PASSWORD_HASHER,
    TOTP_SERVICE,
  ],
})
export class InfrastructureModule {}
