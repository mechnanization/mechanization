import { SetMetadata } from '@nestjs/common';

export const COUNT_PER_STAFF_ACCOUNT_KEY = 'countPerStaffAccount';

/**
 * Counts this route's requests per staff account as well as per address: the
 * `staffAccount` throttler (`presentation/http/throttlers.ts`), keyed by the
 * email in the body, skips every route that does not carry this (audit SEC-04,
 * decision U-6 of 2026-11-28). On staff sign-in alone today.
 */
export const CountPerStaffAccount = () => SetMetadata(COUNT_PER_STAFF_ACCOUNT_KEY, true);
