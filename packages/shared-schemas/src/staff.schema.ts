import { z } from 'zod';
import { staffRoleSchema } from './enums';

export const inspectorPropertyBreakdownSchema = z.object({
  houses: z.number().int().nonnegative(),
  apartments: z.number().int().nonnegative(),
  buildings: z.number().int().nonnegative(),
  lands: z.number().int().nonnegative(),
  tents: z.number().int().nonnegative(),
  commercial: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  totalUnits: z.number().int().nonnegative(),
});

export type InspectorPropertyBreakdown = z.infer<typeof inspectorPropertyBreakdownSchema>;

export const inspectorPayoutItemSchema = z.object({
  id: z.string().uuid(),
  amount: z.number().nonnegative(),
  currency: z.string().default('USD'),
  paidAt: z.string(),
  note: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  recordedByName: z.string().nullable().optional(),
  createdAt: z.string(),
  /**
   * The «PV-» voucher that paid it, once the treasury is live (migration 0083);
   * null for a payout recorded before. `voided` means the voucher was
   * cancelled and the money went back to its wallet, so this payout no longer
   * counts toward what was paid.
   */
  voucher: z
    .object({
      id: z.string().uuid(),
      voucherNumber: z.string(),
      accountName: z.string(),
      voided: z.boolean(),
    })
    .nullable()
    .default(null),
});

export type InspectorPayoutItem = z.infer<typeof inspectorPayoutItemSchema>;

export const inspectorRegistrationLogItemSchema = z.object({
  registrationId: z.string().uuid(),
  citizenId: z.string().uuid(),
  citizenName: z.string(),
  referenceNumber: z.string(),
  submittedAt: z.string(),
  status: z.string(),
  propertyCount: z.number().int().nonnegative(),
  neighborhoods: z.array(z.string()),
  propertyNumbers: z.array(z.string()),
  propertyTypes: z.array(z.string()),
  commissionEarned: z.number().nonnegative(),
});

export type InspectorRegistrationLogItem = z.infer<typeof inspectorRegistrationLogItemSchema>;

export const inspectorProfileResponseSchema = z.object({
  inspector: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().nullable(),
    role: staffRoleSchema,
    isActive: z.boolean(),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
  }),
  totalCitizens: z.number().int().nonnegative().default(0),
  totalProperties: z.number().int().nonnegative(),
  commissionRate: z.number().default(1.0),
  totalEarnings: z.number().nonnegative(),
  paidBalance: z.number().nonnegative(),
  pendingBalance: z.number().nonnegative(),
  /**
   * What was paid over and above what was earned.
   *
   * `pendingBalance` is `max(0, earned - paid)`, so an inspector paid more than
   * he earned reads as settled rather than as owing money back — the one state
   * nobody would want hidden. It can arise without anyone erring: a record
   * corrected away after its payout lowers the total underneath a payment
   * already made. Reported separately so `pendingBalance` keeps meaning "still
   * to pay" for the payout rule, which must never offer a negative.
   */
  overpaidBalance: z.number().nonnegative().default(0),
  breakdown: inspectorPropertyBreakdownSchema,
  recentRegistrations: z.array(inspectorRegistrationLogItemSchema),
  payouts: z.array(inspectorPayoutItemSchema),
});

export type InspectorProfileResponse = z.infer<typeof inspectorProfileResponseSchema>;

/**
 * One commission payout.
 *
 * Two shapes share this schema, and the server picks by whether the treasury is
 * live (docs/finance.md §5.6). Before go-live a payout is a figure and nothing
 * else: no wallet, and `paidAt` may date it. Once live it is paid now, from
 * `accountId` — a dollar wallet — as a «PV-» voucher in «تعويضات المسح
 * والجباية», and `clientRequestId` keeps a retried press from paying twice.
 * The server refuses the wrong half for the state it is in.
 */
export const recordInspectorPayoutSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  currency: z.string().default('USD'),
  paidAt: z.string().optional(),
  note: z.string().max(500).optional(),
  reference: z.string().max(100).optional(),
  /** The paying wallet. Required once the treasury is live, refused before. */
  accountId: z.string().uuid('اختر الحساب الذي ستُدفع منه العمولة').optional(),
  /** One id per press; with the treasury live it is the voucher's retry key. */
  clientRequestId: z.string().uuid().optional(),
});

export type RecordInspectorPayoutInput = z.infer<typeof recordInspectorPayoutSchema>;

