/**
 * Repository ports are declared here and implemented in
 * `infrastructure/repositories/`. None of them take a tenant argument: the
 * implementation resolves the tenant-scoped client from the request's
 * AsyncLocalStorage scope, so there is no parameter a caller could pass wrongly.
 */
export interface BaseRepository<T, TId = string> {
  findById(id: TId): Promise<T | null>;
}

/** DI tokens. String tokens keep `application/` free of infrastructure imports. */
export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const REGISTRATION_REPOSITORY = Symbol('REGISTRATION_REPOSITORY');
export const PARCEL_REPOSITORY = Symbol('PARCEL_REPOSITORY');
export const ZONE_REPOSITORY = Symbol('ZONE_REPOSITORY');
export const CASE_REPOSITORY = Symbol('CASE_REPOSITORY');
export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
export const OTP_REPOSITORY = Symbol('OTP_REPOSITORY');
export const IMAGE_STORAGE_SERVICE = Symbol('IMAGE_STORAGE_SERVICE');
export const CADASTRE_STORAGE_SERVICE = Symbol('CADASTRE_STORAGE_SERVICE');
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const SMS_SENDER = Symbol('SMS_SENDER');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const TOTP_SERVICE = Symbol('TOTP_SERVICE');
export const SUPABASE_AUTH_SERVICE = Symbol('SUPABASE_AUTH_SERVICE');
